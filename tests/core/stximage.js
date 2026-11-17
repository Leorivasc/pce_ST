"use strict";
// Builds a Pasti .stx image from a plain .st image (720K, 80 tracks, 2 sides, 9 sectors).
// Only what PCE's loader reads is written: the file header, one track record per
// track and side with 16-byte sector descriptors, and the sector data. Options let a
// test add what makes a Pasti image different from a .st: a bad data CRC and a
// "record not found" sector.

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// options.badCrc: [{track, side, sector}] sectors flagged with a data CRC error.
// options.noData: [{track, side, sector}] sectors flagged "record not found".
function stFromToStx(st, options) {
  const opts = options || {};
  const TRACKS = 80, SIDES = 2, SECTORS = 9, SIZE = 512;
  const has = function (list, t, h, s) {
    return (list || []).some(function (e) { return e.track === t && e.side === h && e.sector === s; });
  };
  const header = Buffer.alloc(16);
  header.writeUInt32BE(0x52535900, 0);             // "RSY\0"
  header.writeUInt16LE(3, 4);                      // version
  header.writeUInt16LE(1, 6);                      // tool
  header[10] = TRACKS * SIDES;                     // number of track records
  header[11] = 2;                                  // revision
  const records = [header];
  for (let t = 0; t < TRACKS; t++) {
    for (let h = 0; h < SIDES; h++) {
      const descriptors = Buffer.alloc(16 * SECTORS);
      const data = [];
      let dofs = 0;
      for (let s = 1; s <= SECTORS; s++) {
        const d = descriptors.subarray((s - 1) * 16, s * 16);
        const id = Buffer.from([t, h, s, 2]);      // 2 = 512 bytes
        let status = 0;
        if (has(opts.badCrc, t, h, s)) status |= 0x08;
        if (has(opts.noData, t, h, s)) status |= 0x10;
        d.writeUInt32LE(dofs, 0);
        d.writeUInt16LE(0, 4);                     // position: let PCE lay it out
        d.writeUInt16LE(0, 6);
        id.copy(d, 8);
        d.writeUInt16BE(crc16(Buffer.concat([Buffer.from([0xa1, 0xa1, 0xa1, 0xfe]), id])), 12);
        d[14] = status;
        const lba = (t * SIDES + h) * SECTORS + (s - 1);
        data.push(st.subarray(lba * SIZE, (lba + 1) * SIZE));
        dofs += SIZE;
      }
      const body = Buffer.concat([descriptors].concat(data));
      const track = Buffer.alloc(16);
      track.writeUInt32LE(16 + body.length, 0);    // size of the whole record
      track.writeUInt32LE(0, 4);                   // fuzzy mask bytes
      track.writeUInt16LE(SECTORS, 8);
      track.writeUInt16LE(1, 10);                  // flag: sector descriptors present
      track.writeUInt16LE(6250, 12);               // track length in bytes
      track[14] = t | (h << 7);
      records.push(track, body);
    }
  }
  return Buffer.concat(records);
}

module.exports = { stFromToStx: stFromToStx };
