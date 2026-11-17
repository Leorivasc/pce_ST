/* global __dirname, console, process, require */
// Pasti (.stx) to PRI conversion (web/js/core/stx_convert.js). The converted tracks are read
// back with an independent MFM decoder and compared with what the .stx says.

const assert = require("node:assert/strict");
const path = require("node:path");
const { makeBlankST } = require("../core/stimage.js");
const { stFromToStx, trackImage } = require("../core/stximage.js");
const Stx = require(path.join(__dirname, "..", "..", "web", "js", "core", "stx_convert.js"));

// ---- a small PRI reader and MFM decoder ----

function crc32(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x1edc6f41) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

// Returns { chunks: [type], tracks: { "c/h": {bits, clock, data} } } and checks every chunk CRC.
function readPri(bytes) {
  const buf = Buffer.from(bytes), chunks = [], tracks = {};
  let p = 0, current = null;
  while (p < buf.length) {
    const type = buf.toString("latin1", p, p + 4), size = buf.readUInt32BE(p + 4);
    assert.equal(buf.readUInt32BE(p + 8 + size), crc32(buf.subarray(p, p + 8 + size)), "CRC of the " + type + " chunk");
    const data = buf.subarray(p + 8, p + 8 + size);
    if (type === "TRAK") { current = { bits: data.readUInt32BE(8), clock: data.readUInt32BE(12), data: null }; tracks[data.readUInt32BE(0) + "/" + data.readUInt32BE(4)] = current; }
    if (type === "DATA") current.data = data;
    chunks.push(type);
    p += 12 + size;
  }
  return { chunks: chunks, tracks: tracks };
}

// MFM cells to bytes. sync[i] is true where the 16 cells are a missing-clock A1 or C2.
function decodeTrack(track) {
  const bit = function (i) { return (track.data[i >> 3] >> (7 - (i & 7))) & 1; };
  const bytes = [], sync = [];
  for (let i = 0; i < Math.floor(track.bits / 16); i++) {
    let cells = 0;
    for (let k = 0; k < 16; k++) cells = (cells << 1) | bit(i * 16 + k);
    let value = 0;
    for (let k = 0; k < 8; k++) value = (value << 1) | ((cells >> (14 - 2 * k)) & 1);
    bytes.push(value);
    sync.push(cells === 0x4489 || cells === 0x5224);
  }
  return { bytes: bytes, sync: sync };
}

// The sectors found on a decoded track: { id, idCrcOk, data, dataCrcOk } (data null if no data mark).
function findSectors(decoded) {
  const { bytes, sync } = decoded, found = [];
  for (let i = 0; i + 10 < bytes.length; i++) {
    if (!(sync[i] && sync[i + 1] && sync[i + 2] && bytes[i + 3] === 0xfe)) continue;
    const id = bytes.slice(i + 4, i + 8);
    const sector = { id: id, idCrcOk: Stx.crc16([0xa1, 0xa1, 0xa1, 0xfe].concat(id)) === ((bytes[i + 8] << 8) | bytes[i + 9]), data: null, dataCrcOk: false };
    const size = 128 << (id[3] & 3);
    for (let j = i + 10; j < i + 10 + 80 && j + 3 < bytes.length; j++) {
      if (sync[j] && sync[j + 1] && sync[j + 2] && bytes[j + 3] === 0xfb) {
        sector.data = Buffer.from(bytes.slice(j + 4, j + 4 + size));
        sector.dataCrcOk = Stx.crc16([0xa1, 0xa1, 0xa1, 0xfb].concat(Array.from(sector.data))) === ((bytes[j + 4 + size] << 8) | bytes[j + 5 + size]);
        break;
      }
    }
    found.push(sector);
  }
  return found;
}

function view(pri, track, side) { return findSectors(decodeTrack(readPri(pri).tracks[track + "/" + side])); }

function main() {
  const st = makeBlankST("TESTDISK", [{ name: "HELLO.TXT", data: "hello" }]);

  // A plain image: every track is built from the sector table.
  const plain = Stx.convert(new Uint8Array(stFromToStx(st)));
  assert.deepEqual(plain.info, { tracks: 160, withImage: 0, built: 160 });
  assert.equal(plain.raw, null, "no track image, no raw view");
  const pri = readPri(plain.sectors);
  assert.equal(pri.chunks[0], "PRI ");
  assert.equal(pri.chunks[pri.chunks.length - 1], "END ");
  assert.equal(Object.keys(pri.tracks).length, 160);
  assert.equal(pri.tracks["0/0"].clock, 500000);
  assert.ok(pri.tracks["0/0"].bits >= 6250 * 16, "a track holds at least 6250 bytes of cells");

  // Sector 5 of track 3, side 1: ID, data and both CRCs come back as in the image.
  const sectors = view(plain.sectors, 3, 1);
  assert.equal(sectors.length, 9);
  assert.deepEqual(sectors.map(function (s) { return s.id[2]; }), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(sectors[4].id, [3, 1, 5, 2]);
  const lba = (3 * 2 + 1) * 9 + 4;
  assert.ok(sectors[4].data.equals(st.subarray(lba * 512, (lba + 1) * 512)), "sector data equals the .st image");
  assert.ok(sectors.every(function (s) { return s.idCrcOk && s.dataCrcOk; }), "all CRCs are good");

  // Status flags: a bad data CRC stays bad, a missing data field stays missing.
  const flagged = Stx.convert(new Uint8Array(stFromToStx(st, { badCrc: [{ track: 10, side: 0, sector: 2 }], noData: [{ track: 11, side: 1, sector: 7 }] })));
  const bad = view(flagged.sectors, 10, 0)[1];
  assert.equal(bad.dataCrcOk, false, "the sector flagged with a CRC error has a wrong data CRC");
  assert.equal(bad.idCrcOk, true);
  assert.equal(view(flagged.sectors, 10, 0)[0].dataCrcOk, true, "its neighbour is fine");
  assert.equal(view(flagged.sectors, 11, 1)[6].data, null, "the sector flagged 'record not found' has no data field");
  assert.equal(view(flagged.sectors, 11, 1)[5].dataCrcOk, true);

  // A track image that disagrees with the table: the sector view takes the table's data, the
  // raw view keeps the image's. Both stay readable (valid CRCs).
  st.fill(0x55, 0, 512);
  const image = trackImage(0, 0, function (s) { return Buffer.alloc(512, s === 1 ? 0xaa : 0x55); });
  const protectedStx = Stx.convert(new Uint8Array(stFromToStx(st, { images: [{ track: 0, side: 0, image: image }] })));
  assert.deepEqual(protectedStx.info, { tracks: 160, withImage: 1, built: 159 });
  const sectorView = view(protectedStx.sectors, 0, 0), rawView = view(protectedStx.raw, 0, 0);
  assert.ok(sectorView[0].data.equals(Buffer.alloc(512, 0x55)), "sector view: the table's data");
  assert.ok(rawView[0].data.equals(Buffer.alloc(512, 0xaa)), "raw view: the track image's data");
  assert.ok(sectorView[0].dataCrcOk && rawView[0].dataCrcOk, "the data CRC matches the data in both views");
  assert.equal(readPri(protectedStx.raw).tracks["1/0"].bits, readPri(protectedStx.sectors).tracks["1/0"].bits, "tracks without an image are the same in both views");

  // The status flags apply to sectors of a track with an image too.
  const flaggedImage = Stx.convert(new Uint8Array(stFromToStx(st, { images: [{ track: 0, side: 0, image: image }], badCrc: [{ track: 0, side: 0, sector: 3 }] })));
  const flaggedSectors = view(flaggedImage.sectors, 0, 0);
  assert.equal(flaggedSectors[2].dataCrcOk, false, "a CRC error flagged in the table is kept on a track with an image");
  assert.equal(flaggedSectors[1].dataCrcOk, true);
  assert.equal(view(flaggedImage.raw, 0, 0)[2].dataCrcOk, true, "the raw view is untouched");

  // The table decides the IDs of the sector view (protected disks may disagree with their image).
  const odd = new Uint8Array(stFromToStx(st, { images: [{ track: 0, side: 0, image: image }] }));
  const parsed = Stx.parse(odd);
  assert.equal(parsed[0].sectors.length, 9);
  assert.equal(parsed[0].image.length, 6250);
  assert.equal(parsed[1].image, null);

  // Read Track dumps show the first sync byte of a mark as another value ("xx A1 A1 FE"): the
  // converter writes the missing third sync byte, otherwise the ID CRC (over three A1) fails.
  const dumped = Buffer.from(image);
  const idMark = dumped.indexOf(Buffer.from([0xa1, 0xa1, 0xa1, 0xfe]));
  dumped[idMark] = 0x14;
  const fromDump = Stx.convert(new Uint8Array(stFromToStx(st, { images: [{ track: 0, side: 0, image: dumped }] })));
  const dumpedSectors = view(fromDump.raw, 0, 0);
  assert.equal(dumpedSectors.length, 9, "all nine address marks are found, the damaged one included");
  assert.deepEqual(dumpedSectors[0].id, [0, 0, 1, 2]);
  assert.ok(dumpedSectors[0].idCrcOk, "an address mark with two sync bytes is written with three");

  // Invalid input.
  assert.throws(function () { Stx.convert(new Uint8Array(32)); }, { code: "bad_image", message: /bad header/ });
  assert.throws(function () { Stx.convert(new Uint8Array(0)); }, { code: "bad_image" });
  const truncated = new Uint8Array(stFromToStx(st)).subarray(0, 1000);
  assert.throws(function () { Stx.convert(truncated); }, { code: "bad_image", message: /Truncated/ });
  const empty = Buffer.alloc(16); empty.writeUInt32BE(0x52535900, 0);
  assert.deepEqual(Stx.convert(new Uint8Array(empty)).info, { tracks: 0, withImage: 0, built: 0 }, "a header with no tracks converts to an empty disk");

  console.log("stx_convert.test.js passed");
}

try { main(); } catch (err) { console.error(err && err.stack ? err.stack : err); process.exit(1); }
