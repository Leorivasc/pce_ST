// Builds Atari ST floppy images: a FAT12 volume, 720K, double sided, 9 sectors per
// track (the format TOS creates), optionally holding files in its root directory.
(function (root) {
  "use strict";

  const SECTOR = 512, TOTAL = 1440, SPC = 2, SPF = 3, ROOT_ENTRIES = 112;
  const ROOT_START = 1 + 2 * SPF;
  const DATA_START = ROOT_START + ROOT_ENTRIES * 32 / SECTOR;
  const MAX_CLUSTERS = (TOTAL - DATA_START) / SPC;

  // "My Game v2.prg" -> { base: "MYGAMEV2", ext: "PRG" } (8.3, upper case, no spaces).
  function shortName(name) {
    const text = String(name || "").toUpperCase();
    const dot = text.lastIndexOf(".");
    const clean = function (part, max) {
      return part.replace(/[^A-Z0-9_!#$%&'()\-@^`{}~]/g, "").substring(0, max);
    };
    const base = clean(dot > 0 ? text.substring(0, dot) : text, 8) || "NONAME";
    const ext = dot > 0 ? clean(text.substring(dot + 1), 3) : "";
    return { base: base, ext: ext };
  }

  function createFloppy(options) {
    const opts = options || {};
    const img = new Uint8Array(TOTAL * SECTOR);
    const view = new DataView(img.buffer);
    const put = function (text, offset, length) {
      const padded = String(text).padEnd(length, " ").substring(0, length);
      for (let i = 0; i < length; i++) img[offset + i] = padded.charCodeAt(i) & 0x7f;
    };

    img[0] = 0xe9;
    put("PCEST  ", 3, 7);
    view.setUint16(11, SECTOR, true);
    img[13] = SPC;
    view.setUint16(14, 1, true);
    img[16] = 2;
    view.setUint16(17, ROOT_ENTRIES, true);
    view.setUint16(19, TOTAL, true);
    img[21] = 0xf9;
    view.setUint16(22, SPF, true);
    view.setUint16(24, 9, true);
    view.setUint16(26, 2, true);

    const fat = new Uint8Array(SPF * SECTOR);
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

    // 1 Jan 2026, 12:00
    const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1, TIME = 12 << 11;
    let entry = 0;
    let nextCluster = 2;
    function dirEntry(base, ext, attr, cluster, size) {
      if (entry >= ROOT_ENTRIES) throw new Error("The floppy's root directory is full");
      const o = ROOT_START * SECTOR + entry * 32;
      put(base, o, 8);
      put(ext, o + 8, 3);
      img[o + 11] = attr;
      view.setUint16(o + 22, TIME, true);
      view.setUint16(o + 24, DATE, true);
      view.setUint16(o + 26, cluster, true);
      view.setUint32(o + 28, size, true);
      entry++;
    }

    if (opts.label) {
      const label = shortName(opts.label);
      dirEntry(label.base, label.ext, 0x08, 0, 0);
    }
    (opts.files || []).forEach(function (file) {
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const clusters = Math.max(1, Math.ceil(data.length / (SPC * SECTOR)));
      if (nextCluster - 2 + clusters > MAX_CLUSTERS) throw new Error("The files do not fit on a 720K floppy");
      const first = nextCluster;
      for (let i = 0; i < clusters; i++) {
        const c = nextCluster++;
        setFat(c, i === clusters - 1 ? 0xfff : c + 1);
        const chunk = data.subarray(i * SPC * SECTOR, Math.min(data.length, (i + 1) * SPC * SECTOR));
        img.set(chunk, (DATA_START + (c - 2) * SPC) * SECTOR);
      }
      const name = shortName(file.name);
      dirEntry(name.base, name.ext, 0x20, data.length ? first : 0, data.length);
    });

    img.set(fat, 1 * SECTOR);
    img.set(fat, (1 + SPF) * SECTOR);
    return img;
  }

  // Reads the BIOS parameter block and walks every directory, checking that each
  // file's cluster chain is well formed. Works on any FAT12 floppy image (not only
  // the ones createFloppy builds).
  function verify(bytes) {
    const report = {
      valid: false, filesystemKnown: false, errors: [], warnings: [],
      checkedFiles: 0, checkedSectors: 0, files: [], label: "",
    };
    const fail = function (message) { report.errors.push(message); return report; };
    if (!bytes || bytes.length < 512 || bytes.length % 512 !== 0) return fail("Image size is not a multiple of 512 bytes");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bps = view.getUint16(11, true), spc = bytes[13], reserved = view.getUint16(14, true);
    const fats = bytes[16], rootEntries = view.getUint16(17, true), spf = view.getUint16(22, true);
    let total = view.getUint16(19, true);
    if (!total) total = view.getUint32(32, true);
    if (bps !== 512 || !spc || (spc & (spc - 1)) || !reserved || !fats || !spf || !rootEntries) {
      return fail("No valid FAT12 boot sector");
    }
    report.filesystemKnown = true;
    if (total * bps > bytes.length) return fail("The boot sector describes more sectors than the image holds");
    if (total * bps < bytes.length) report.warnings.push("The image is larger than its file system");
    const rootStart = reserved + fats * spf;
    const dataStart = rootStart + Math.ceil(rootEntries * 32 / bps);
    const clusterCount = Math.floor((total - dataStart) / spc);
    if (clusterCount < 1 || clusterCount >= 4085) return fail("Not a FAT12 volume");
    report.checkedSectors = total;
    const fatAt = function (cluster) {
      const o = reserved * bps + Math.floor(cluster * 3 / 2);
      const value = bytes[o] | (bytes[o + 1] << 8);
      return cluster & 1 ? value >> 4 : value & 0xfff;
    };
    const clusterBytes = spc * bps;
    function chain(first, label) {
      const seen = new Set();
      let cluster = first, count = 0;
      while (cluster >= 2 && cluster < 0xff8) {
        if (cluster >= clusterCount + 2) { report.errors.push(label + ": cluster outside the volume"); return -1; }
        if (seen.has(cluster)) { report.errors.push(label + ": cluster chain loops"); return -1; }
        seen.add(cluster); count++;
        cluster = fatAt(cluster);
      }
      if (cluster < 0xff8) { report.errors.push(label + ": cluster chain ends in a free or bad cluster"); return -1; }
      return count;
    }
    function dirBytes(first, isRoot) {
      if (isRoot) return bytes.subarray(rootStart * bps, rootStart * bps + rootEntries * 32);
      const parts = [];
      const seen = new Set();
      for (let c = first; c >= 2 && c < 0xff8 && !seen.has(c) && c < clusterCount + 2; c = fatAt(c)) {
        seen.add(c);
        const o = (dataStart + (c - 2) * spc) * bps;
        parts.push(bytes.subarray(o, o + clusterBytes));
      }
      const out = new Uint8Array(parts.length * clusterBytes);
      parts.forEach(function (part, i) { out.set(part, i * clusterBytes); });
      return out;
    }
    function walk(dir, prefix, depth) {
      for (let o = 0; o + 32 <= dir.length; o += 32) {
        if (dir[o] === 0) break;
        if (dir[o] === 0xe5) continue;
        const attr = dir[o + 11];
        const dv = new DataView(dir.buffer, dir.byteOffset + o, 32);
        const text = function (a, b) { return String.fromCharCode.apply(null, Array.from(dir.subarray(o + a, o + b))).trim(); };
        const base = text(0, 8), ext = text(8, 11);
        const name = ext ? base + "." + ext : base;
        if (attr & 0x08) { if (!prefix) report.label = name; continue; }
        if (base === "." || base === "..") continue;
        const first = dv.getUint16(26, true), size = dv.getUint32(28, true);
        const path = prefix + name;
        if (attr & 0x10) {
          if (depth > 8) { report.errors.push(path + ": folders nested too deeply"); continue; }
          if (chain(first, path) > 0) walk(dirBytes(first, false), path + "/", depth + 1);
          continue;
        }
        report.checkedFiles++;
        report.files.push({ path: path, size: size });
        const clusters = size ? chain(first, path) : 0;
        if (clusters >= 0 && Math.ceil(size / clusterBytes) !== clusters) {
          report.errors.push(path + ": size does not match its cluster chain");
        }
      }
    }
    walk(dirBytes(0, true), "", 0);
    report.valid = report.errors.length === 0;
    return report;
  }

  // ---- reading ----

  // Opens a FAT12 volume for reading. Returns null when the image is not one.
  // volume.list(cluster) lists a directory (0 = the root): [{name, isDir, size,
  // cluster, attr}], without the volume label and the "." and ".." entries;
  // volume.read(entry) returns a file's bytes.
  function openVolume(bytes) {
    if (!bytes || bytes.length < 512) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bps = view.getUint16(11, true), spc = bytes[13], reserved = view.getUint16(14, true);
    const fats = bytes[16], rootEntries = view.getUint16(17, true), spf = view.getUint16(22, true);
    let total = view.getUint16(19, true);
    if (!total) total = view.getUint32(32, true);
    if (bps !== 512 || !spc || (spc & (spc - 1)) || !reserved || !fats || !spf || !rootEntries) return null;
    if (total * bps > bytes.length) return null;
    const rootStart = reserved + fats * spf;
    const dataStart = rootStart + Math.ceil(rootEntries * 32 / bps);
    const clusterCount = Math.floor((total - dataStart) / spc);
    if (clusterCount < 1 || clusterCount >= 4085) return null;
    const clusterBytes = spc * bps;
    const fatAt = function (cluster) {
      const o = reserved * bps + Math.floor(cluster * 3 / 2);
      const value = bytes[o] | (bytes[o + 1] << 8);
      return cluster & 1 ? value >> 4 : value & 0xfff;
    };
    // The clusters of a chain; stops at a loop or an invalid cluster.
    const chain = function (first) {
      const out = [];
      const seen = new Set();
      for (let c = first; c >= 2 && c < 0xff8 && c < clusterCount + 2 && !seen.has(c); c = fatAt(c)) {
        seen.add(c);
        out.push(c);
      }
      return out;
    };
    const readClusters = function (clusters, limit) {
      const out = new Uint8Array(Math.min(limit, clusters.length * clusterBytes));
      clusters.forEach(function (c, i) {
        const o = (dataStart + (c - 2) * spc) * bps;
        const part = bytes.subarray(o, o + clusterBytes);
        if (i * clusterBytes < out.length) out.set(part.subarray(0, out.length - i * clusterBytes), i * clusterBytes);
      });
      return out;
    };
    const dirBytes = function (cluster) {
      if (!cluster) return bytes.subarray(rootStart * bps, rootStart * bps + rootEntries * 32);
      return readClusters(chain(cluster), Infinity);
    };
    const text = function (dir, o, a, b) {
      return String.fromCharCode.apply(null, Array.from(dir.subarray(o + a, o + b))).trim();
    };
    const volume = { label: "", clusterBytes: clusterBytes };
    volume.list = function (cluster) {
      const dir = dirBytes(cluster || 0);
      const out = [];
      for (let o = 0; o + 32 <= dir.length; o += 32) {
        if (dir[o] === 0) break;
        if (dir[o] === 0xe5) continue;
        const attr = dir[o + 11];
        const base = text(dir, o, 0, 8), ext = text(dir, o, 8, 11);
        const name = ext ? base + "." + ext : base;
        if (attr & 0x08) { if (!cluster) volume.label = name; continue; }
        if (base === "." || base === "..") continue;
        const dv = new DataView(dir.buffer, dir.byteOffset + o, 32);
        out.push({ name: name, isDir: !!(attr & 0x10), attr: attr, cluster: dv.getUint16(26, true), size: dv.getUint32(28, true) });
      }
      return out;
    };
    volume.read = function (entry) {
      if (entry.isDir) throw new Error(entry.name + " is a folder");
      if (!entry.size) return new Uint8Array(0);
      return readClusters(chain(entry.cluster), entry.size);
    };
    volume.list(0);   // fills in the label
    return volume;
  }

  // ---- MSA (Magic Shadow Archiver) images ----

  // Returns the raw .st bytes of an .msa image (tracks are optionally RLE-compressed).
  function decodeMsa(bytes) {
    if (!bytes || bytes.length < 10 || bytes[0] !== 0x0e || bytes[1] !== 0x0f) throw new Error("Not an MSA image");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const spt = view.getUint16(2, false), sides = view.getUint16(4, false) + 1;
    const first = view.getUint16(6, false), last = view.getUint16(8, false);
    if (!spt || spt > 36 || sides > 2 || last < first || last > 100) throw new Error("Invalid MSA header");
    const trackBytes = spt * 512;
    const out = new Uint8Array((last + 1) * sides * trackBytes);
    let pos = 10;
    for (let track = first; track <= last; track++) {
      for (let side = 0; side < sides; side++) {
        if (pos + 2 > bytes.length) throw new Error("The MSA image is truncated");
        const length = view.getUint16(pos, false);
        pos += 2;
        if (pos + length > bytes.length) throw new Error("The MSA image is truncated");
        const dest = (track * sides + side) * trackBytes;
        if (length === trackBytes) {
          out.set(bytes.subarray(pos, pos + length), dest);
        } else {
          let i = pos, o = 0;
          const end = pos + length;
          while (i < end) {
            const b = bytes[i++];
            if (b === 0xe5 && i + 3 <= end) {
              const value = bytes[i], count = (bytes[i + 1] << 8) | bytes[i + 2];
              i += 3;
              if (o + count > trackBytes) throw new Error("Corrupt MSA track");
              out.fill(value, dest + o, dest + o + count);
              o += count;
            } else {
              if (o >= trackBytes) throw new Error("Corrupt MSA track");
              out[dest + o++] = b;
            }
          }
          if (o !== trackBytes) throw new Error("Corrupt MSA track");
        }
        pos += length;
      }
    }
    return out;
  }

  // Normalizes a file the user supplies to a floppy format the library stores:
  // .msa becomes a raw .st; .st and .prg are returned as they are.
  function toLibraryFile(name, bytes) {
    if (/\.msa$/i.test(name)) return { name: name.replace(/\.msa$/i, ".st"), bytes: decodeMsa(bytes) };
    return { name: name, bytes: bytes };
  }

  root.PCE_STImage = { createFloppy: createFloppy, shortName: shortName, verify: verify, openVolume: openVolume, decodeMsa: decodeMsa, toLibraryFile: toLibraryFile, SIZE: TOTAL * SECTOR };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PCE_STImage;
})(typeof window !== "undefined" ? window : this);
