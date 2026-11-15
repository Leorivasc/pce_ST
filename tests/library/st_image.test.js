/* global __dirname, console */
const assert = require("node:assert/strict");
const path = require("node:path");
const image = require(path.join(__dirname, "..", "..", "web", "js", "core", "st_image.js"));

// A blank floppy is a valid 720K FAT12 volume.
const blank = image.createFloppy({ label: "PCE_ST" });
assert.equal(blank.length, 720 * 1024);
const blankReport = image.verify(blank);
assert.equal(blankReport.valid, true, blankReport.errors.join("; "));
assert.equal(blankReport.filesystemKnown, true);
assert.equal(blankReport.label, "PCE_ST");
assert.equal(blankReport.checkedFiles, 0);

// Files: long ones span several clusters; names become 8.3.
const big = new Uint8Array(5000).map(function (_, i) { return i & 255; });
const withFiles = image.createFloppy({ files: [
  { name: "My Game v2.prg", data: big },
  { name: "readme.txt", data: new Uint8Array([65, 66]) },
  { name: "empty.dat", data: new Uint8Array(0) },
] });
const report = image.verify(withFiles);
assert.equal(report.valid, true, report.errors.join("; "));
assert.deepEqual(report.files.map(function (f) { return f.path + ":" + f.size; }),
  ["MYGAMEV2.PRG:5000", "README.TXT:2", "EMPTY.DAT:0"]);

// Corruption is detected.
const broken = new Uint8Array(withFiles);
broken[512 + 3] = 0x02; broken[512 + 4] = 0x00;        // cluster 2 points to cluster 2
const brokenReport = image.verify(broken);
assert.equal(brokenReport.valid, false);
assert.ok(brokenReport.errors.some(function (e) { return /loops/.test(e); }));

// Not a file system, wrong sizes.
assert.equal(image.verify(new Uint8Array([1, 2, 3])).valid, false);
const zeros = image.verify(new Uint8Array(720 * 1024));
assert.equal(zeros.valid, false);
assert.equal(zeros.filesystemKnown, false);

// Too much data is refused.
assert.throws(function () {
  image.createFloppy({ files: [{ name: "big.bin", data: new Uint8Array(800 * 1024) }] });
}, /do not fit/);
// The reader lists what the builder wrote (and folders, through the FAT chain).
const volume = image.openVolume(withFiles);
assert.equal(volume.list(0).map(function (e) { return e.name + ":" + e.size; }).join(","), "MYGAMEV2.PRG:5000,README.TXT:2,EMPTY.DAT:0");
const entry = volume.list(0)[0];
assert.deepEqual(Array.from(volume.read(entry)), Array.from(big), "a multi-cluster file reads back exactly");
assert.equal(Buffer.from(volume.read(volume.list(0)[1])).toString(), "AB");
assert.equal(volume.read(volume.list(0)[2]).length, 0);
assert.equal(image.openVolume(blank).label, "PCE_ST");
assert.equal(image.openVolume(new Uint8Array(1024)), null);

// MSA: a test encoder (RLE for runs of 4 or more, as the format defines) round-trips.
function encodeMsa(raw, spt, sides, tracks) {
  const parts = [];
  const header = Buffer.alloc(10);
  header.writeUInt16BE(0x0e0f, 0); header.writeUInt16BE(spt, 2); header.writeUInt16BE(sides - 1, 4);
  header.writeUInt16BE(0, 6); header.writeUInt16BE(tracks - 1, 8);
  parts.push(header);
  const trackBytes = spt * 512;
  for (let t = 0; t < tracks * sides; t++) {
    const track = raw.subarray(t * trackBytes, (t + 1) * trackBytes);
    const out = [];
    for (let i = 0; i < track.length;) {
      let run = 1;
      while (i + run < track.length && track[i + run] === track[i] && run < 65535) run++;
      if (run >= 4 || track[i] === 0xe5) {
        out.push(0xe5, track[i], run >> 8, run & 255);
        i += run;
      } else { out.push(track[i]); i++; }
    }
    const data = out.length < trackBytes ? Buffer.from(out) : Buffer.from(track);
    const len = Buffer.alloc(2); len.writeUInt16BE(data.length, 0);
    parts.push(len, data);
  }
  return Buffer.concat(parts);
}
const msa = encodeMsa(withFiles, 9, 2, 80);
assert.ok(msa.length < withFiles.length / 4, "mostly empty tracks compress");
assert.deepEqual(Array.from(image.decodeMsa(new Uint8Array(msa))), Array.from(withFiles));
const converted = image.toLibraryFile("GAME.MSA", new Uint8Array(msa));
assert.equal(converted.name, "GAME.st");
assert.equal(converted.bytes.length, 720 * 1024);
assert.equal(image.toLibraryFile("a.prg", new Uint8Array([1])).name, "a.prg");
assert.throws(function () { image.decodeMsa(new Uint8Array([1, 2, 3])); }, /Not an MSA/);
assert.throws(function () { image.decodeMsa(new Uint8Array(msa.subarray(0, 100))); }, /truncated|Corrupt/);
console.log("st_image.test.js passed");
