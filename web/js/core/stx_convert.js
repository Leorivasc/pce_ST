/* global module */
// Pasti (.stx) to PRI conversion.
//
// PCE's floppy controller works on a bit stream per track (PRI), while a Pasti image holds,
// for each track, a table of sectors and (for protected disks) a raw track image. The two
// can disagree: the table is what Read Sector and Read Address must see, the image is what
// Read Track must see. So one .stx becomes two PRI files that the core attaches to the same
// drive and switches between by command (see "Pasti" in core/st_glue.c):
//   sectors  the image's gaps and layout with the table's IDs, CRCs and data written over it
//            (tracks without an image are built from the table with standard gaps);
//   raw      the track image untouched (null if no track has one).
// The bytes are encoded as MFM. Sync marks (A1 before the address/data marks, C2 before the
// index mark) are written with their missing clock. Not represented: fuzzy bits and the
// per-sector read timing. Written for this project from the format's documentation.
(function (root) {
  "use strict";

  var MAGIC = 0x52535900;                 // "RSY\0"
  var FLAG_SECTORS = 0x01, FLAG_IMAGE = 0x40, FLAG_SYNC = 0x80;
  var ST_CRC_ERROR = 0x08, ST_NO_DATA = 0x10;
  var BIT_CLOCK = 500000;                 // DD MFM cells per second
  var MAX_TRACK_NUMBER = 90;

  function fail(message) { var e = new Error(message); e.code = "bad_image"; return e; }

  function crc16(bytes, crc) {
    crc = crc === undefined ? 0xffff : crc;
    for (var n = 0; n < bytes.length; n++) {
      crc ^= bytes[n] << 8;
      for (var i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  var crc32Table = null;
  function crc32(parts) {
    if (!crc32Table) {
      crc32Table = [];
      for (var i = 0; i < 256; i++) {
        var r = (i << 24) >>> 0;
        for (var j = 0; j < 8; j++) r = (r & 0x80000000) ? (((r << 1) ^ 0x1edc6f41) >>> 0) : ((r << 1) >>> 0);
        crc32Table.push(r);
      }
    }
    var c = 0;
    parts.forEach(function (bytes) {
      for (var n = 0; n < bytes.length; n++) c = (((c << 8) >>> 0) ^ crc32Table[((c >>> 24) ^ bytes[n]) & 0xff]) >>> 0;
    });
    return c >>> 0;
  }

  // ---- reading the .stx ----

  // Returns [{ track, side, sectors: [{...}], image: Uint8Array|null, mfmBytes, data }].
  function parse(bytes) {
    var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 16 || v.getUint32(0, false) !== MAGIC) throw fail("Not a Pasti .stx image (bad header)");
    var count = bytes[10], tracks = [], ofs = 16;
    for (var t = 0; t < count; t++) {
      if (ofs + 16 > bytes.length) throw fail("Truncated .stx image (track " + t + ")");
      var size = v.getUint32(ofs, true), fuzzy = v.getUint32(ofs + 4, true), sectorCount = v.getUint16(ofs + 8, true);
      var flags = v.getUint16(ofs + 10, true), mfmBytes = v.getUint16(ofs + 12, true);
      if (size < 16 || ofs + size > bytes.length) throw fail("Truncated .stx image (track " + t + ")");
      var header = ofs + 16, dataStart = header + sectorCount * 16 + fuzzy;
      if (dataStart > ofs + size) throw fail("Corrupt .stx image (track " + t + ")");
      var track = { track: bytes[ofs + 14] & 0x7f, side: bytes[ofs + 14] >> 7, sectors: [], image: null, mfmBytes: mfmBytes, data: bytes.subarray(dataStart, ofs + size), hasSectors: !!(flags & FLAG_SECTORS) };
      for (var s = 0; s < sectorCount; s++) {
        var o = header + s * 16;
        track.sectors.push({
          dataOffset: v.getUint32(o, true), id: [bytes[o + 8], bytes[o + 9], bytes[o + 10], bytes[o + 11]],
          crc: [bytes[o + 12], bytes[o + 13]], status: bytes[o + 14],
        });
      }
      if (flags & FLAG_IMAGE) {
        var p = (flags & FLAG_SYNC) ? 2 : 0;
        if (p + 2 <= track.data.length) {
          var imageSize = track.data[p] | (track.data[p + 1] << 8);
          if (p + 2 + imageSize <= track.data.length) track.image = track.data.subarray(p + 2, p + 2 + imageSize);
        }
      }
      tracks.push(track);
      ofs += size;
    }
    return tracks;
  }

  // ---- building a track's bytes ----

  // Marks the sync bytes of a raw track image: a run of A1 before an address/data mark, or of
  // C2 before the index mark. An address mark with only two A1 gets the third (the CRC is
  // computed over three). Returns { bytes, sync: Set of positions }.
  function markSync(image) {
    var out = Array.prototype.slice.call(image), sync = {};
    var i = 0;
    while (i < out.length) {
      if (out[i] !== 0xa1 && out[i] !== 0xc2) { i++; continue; }
      var value = out[i], j = i;
      while (j < out.length && out[j] === value) j++;
      var next = out[j];
      var isMark = value === 0xa1 ? (next >= 0xf8 && next <= 0xff) : next === 0xfc;
      if (j - i >= 2 && isMark) {
        for (var k = i; k < j; k++) sync[k] = true;
        if (value === 0xa1 && j - i === 2 && i > 0) { out[i - 1] = 0xa1; sync[i - 1] = true; }
      }
      i = j;
    }
    return { bytes: out, sync: sync };
  }

  // Writes the table's IDs, ID CRCs, data and data CRCs over the track image, matching the
  // sectors to the address marks in order. Returns the number of sectors written.
  function overlaySectors(track, out) {
    var written = 0, from = 0;
    track.sectors.forEach(function (sec) {
      var size = 128 << (sec.id[3] & 3), at = -1, i, k;
      for (i = from; i + 8 < out.length; i++) if (out[i] === 0xa1 && out[i + 1] === 0xfe) { at = i; break; }
      if (at < 0) return;
      for (k = 0; k < 4; k++) out[at + 2 + k] = sec.id[k];
      out[at + 6] = sec.crc[0]; out[at + 7] = sec.crc[1];
      from = at + 8;
      if (sec.status & ST_NO_DATA) return;
      var d = -1;
      for (i = at + 8; i < at + 140 && i + 1 < out.length; i++) if (out[i] === 0xa1 && out[i + 1] >= 0xf8 && out[i + 1] <= 0xfb) { d = i + 2; break; }
      if (d < 0 || d + size + 2 > out.length || track.data.length < sec.dataOffset + size) return;
      var data = track.data.subarray(sec.dataOffset, sec.dataOffset + size);
      for (k = 0; k < size; k++) out[d + k] = data[k];
      var crc = crc16([0xa1, 0xa1, 0xa1, out[d - 1]].concat(Array.prototype.slice.call(data)));
      if (sec.status & ST_CRC_ERROR) crc ^= 0xffff;
      out[d + size] = crc >> 8; out[d + size + 1] = crc & 0xff;
      from = d + size;
      written++;
    });
    return written;
  }

  // A standard track made from the sector table.
  function buildFromSectors(track) {
    var out = [], sync = {};
    function repeat(value, n) { for (var i = 0; i < n; i++) out.push(value); }
    function syncMarks() { for (var i = 0; i < 3; i++) { sync[out.length] = true; out.push(0xa1); } }
    repeat(0x4e, 60);
    track.sectors.forEach(function (sec) {
      var size = 128 << (sec.id[3] & 3);
      repeat(0x00, 12); syncMarks(); out.push(0xfe);
      sec.id.forEach(function (b) { out.push(b); });
      out.push(sec.crc[0], sec.crc[1]);
      if (sec.status & ST_NO_DATA) { repeat(0x4e, 40); return; }
      repeat(0x4e, 22); repeat(0x00, 12); syncMarks(); out.push(0xfb);
      var data = track.data.subarray(sec.dataOffset, sec.dataOffset + size), list = Array.prototype.slice.call(data);
      while (list.length < size) list.push(0);
      list.forEach(function (b) { out.push(b); });
      var crc = crc16([0xa1, 0xa1, 0xa1, 0xfb].concat(list));
      if (sec.status & ST_CRC_ERROR) crc ^= 0xffff;
      out.push(crc >> 8, crc & 0xff);
      repeat(0x4e, 40);
    });
    var want = Math.max(track.mfmBytes || 0, 6250);
    while (out.length < want) out.push(0x4e);
    return { bytes: out, sync: sync };
  }

  // ---- MFM and PRI ----

  function mfmEncode(bytes, sync) {
    var data = new Uint8Array(bytes.length * 2), pos = 0, prev = 0;
    function put(bit) { if (bit) data[pos >> 3] |= 0x80 >> (pos & 7); pos++; }
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (sync[i] && (b === 0xa1 || b === 0xc2)) {
        var pattern = b === 0xa1 ? 0x4489 : 0x5224;
        for (var k = 15; k >= 0; k--) put((pattern >> k) & 1);
        prev = pattern & 1;
        continue;
      }
      for (var m = 7; m >= 0; m--) {
        var bit = (b >> m) & 1;
        put(!prev && !bit ? 1 : 0);
        put(bit);
        prev = bit;
      }
    }
    return { data: data, bits: bytes.length * 16 };
  }

  function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
  function ascii(text) { return new Uint8Array(text.split("").map(function (c) { return c.charCodeAt(0); })); }

  function priChunk(type, data) {
    var head = new Uint8Array(8);
    head.set(ascii(type), 0); head.set(u32(data.length), 4);
    return [head, data, u32(crc32([head, data]))];
  }

  function concat(parts) {
    var total = 0; parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  function writePri(trackList) {
    var parts = priChunk("PRI ", new Uint8Array(4));
    trackList.forEach(function (t) {
      var head = new Uint8Array(16);
      head.set(u32(t.track), 0); head.set(u32(t.side), 4); head.set(u32(t.bits), 8); head.set(u32(BIT_CLOCK), 12);
      parts = parts.concat(priChunk("TRAK", head), priChunk("DATA", t.data));
    });
    parts = parts.concat(priChunk("END ", new Uint8Array(0)));
    return concat(parts);
  }

  // bytes: the .stx file. Returns { sectors: Uint8Array (PRI), raw: Uint8Array (PRI) | null,
  // info: { tracks, withImage, built } }. Throws an Error with code "bad_image".
  function convert(bytes) {
    var tracks = parse(bytes), sectorTracks = [], rawTracks = [], info = { tracks: 0, withImage: 0, built: 0 };
    tracks.forEach(function (t) {
      if (t.track >= MAX_TRACK_NUMBER) return;
      var table = null, raw = null;
      if (t.image) {
        info.withImage++;
        raw = markSync(t.image);
        table = markSync(t.image);
        if (t.sectors.length) overlaySectors(t, table.bytes);
      } else if (t.hasSectors && t.sectors.length) {
        info.built++;
        table = buildFromSectors(t);
      } else return;
      info.tracks++;
      var s = mfmEncode(table.bytes, table.sync);
      sectorTracks.push({ track: t.track, side: t.side, bits: s.bits, data: s.data });
      var r = mfmEncode((raw || table).bytes, (raw || table).sync);
      rawTracks.push({ track: t.track, side: t.side, bits: r.bits, data: r.data });
    });
    return { sectors: writePri(sectorTracks), raw: info.withImage ? writePri(rawTracks) : null, info: info };
  }

  root.PCE_STStx = { convert: convert, parse: parse, crc16: crc16 };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PCE_STStx;
})(typeof window !== "undefined" ? window : this);
