"use strict";
// .st floppy image (FAT12, 720K, double sided, 9 sectors per track) for tests.
// It contains the files passed in `files` ({name, data}).

function makeBlankST(label, files) {
  const SECTOR = 512, TOTAL = 1440, SPC = 2, SPF = 3, ROOT_ENTRIES = 112;
  const img = Buffer.alloc(TOTAL * SECTOR);
  const rootStart = 1 + 2 * SPF;
  const rootSectors = ROOT_ENTRIES * 32 / SECTOR;
  const dataStart = rootStart + rootSectors;

  img[0] = 0xe9; img[1] = 0x00; img[2] = 0x00;
  img.write("PCEST  ", 3, "latin1");
  img.writeUInt16LE(SECTOR, 11);
  img[13] = SPC;
  img.writeUInt16LE(1, 14);
  img[16] = 2;
  img.writeUInt16LE(ROOT_ENTRIES, 17);
  img.writeUInt16LE(TOTAL, 19);
  img[21] = 0xf9;
  img.writeUInt16LE(SPF, 22);
  img.writeUInt16LE(9, 24);
  img.writeUInt16LE(2, 26);

  const fat = Buffer.alloc(SPF * SECTOR);
  fat[0] = 0xf9; fat[1] = 0xff; fat[2] = 0xff;
  function setFat(cluster, value) {
    const o = Math.floor(cluster * 3 / 2);
    if (cluster & 1) {
      fat[o] = (fat[o] & 0x0f) | ((value << 4) & 0xf0);
      fat[o + 1] = (value >> 4) & 0xff;
    } else {
      fat[o] = value & 0xff;
      fat[o + 1] = (fat[o + 1] & 0xf0) | ((value >> 8) & 0x0f);
    }
  }

  let entry = 0;
  let nextCluster = 2;
  function dirEntry(name, attr, cluster, size) {
    const o = rootStart * SECTOR + entry * 32;
    const base = name.split(".")[0], ext = name.split(".")[1] || "";
    img.write(base.toUpperCase().padEnd(8, " ").slice(0, 8), o, "latin1");
    img.write(ext.toUpperCase().padEnd(3, " ").slice(0, 3), o + 8, "latin1");
    img[o + 11] = attr;
    img.writeUInt16LE(0x6000, o + 22);          // time
    img.writeUInt16LE((46 << 9) | (1 << 5) | 1, o + 24); // 1 Jan 2026
    img.writeUInt16LE(cluster, o + 26);
    img.writeUInt32LE(size, o + 28);
    entry++;
  }
  if (label) dirEntry(label, 0x08, 0, 0);
  (files || []).forEach(function (f) {
    const data = Buffer.from(f.data);
    const clusters = Math.max(1, Math.ceil(data.length / (SPC * SECTOR)));
    const first = nextCluster;
    for (let i = 0; i < clusters; i++) {
      const c = nextCluster++;
      setFat(c, i === clusters - 1 ? 0xfff : c + 1);
      data.copy(img, (dataStart + (c - 2) * SPC) * SECTOR, i * SPC * SECTOR, Math.min(data.length, (i + 1) * SPC * SECTOR));
    }
    dirEntry(f.name, 0x20, first, data.length);
  });

  fat.copy(img, 1 * SECTOR);
  fat.copy(img, (1 + SPF) * SECTOR);
  return img;
}

// Root directory entries: [{name, attr, size}] (without the volume label or deleted entries).
function listRoot(img) {
  const rootStart = 1 + 2 * 3;
  const out = [];
  for (let i = 0; i < 112; i++) {
    const o = rootStart * 512 + i * 32;
    if (img[o] === 0) break;
    if (img[o] === 0xe5 || (img[o + 11] & 0x08)) continue;
    const base = img.toString("latin1", o, o + 8).trim();
    const ext = img.toString("latin1", o + 8, o + 11).trim();
    out.push({ name: ext ? base + "." + ext : base, attr: img[o + 11], size: img.readUInt32LE(o + 28) });
  }
  return out;
}

module.exports = { makeBlankST, listRoot };
