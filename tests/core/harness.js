"use strict";
// Helpers to test the core (build/out/pce_st_core.js) from Node.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CORE = path.join(__dirname, "..", "..", "build", "out", "pce_st_core.js");

const DEFAULT_CFG = require("../../core/st_config.js").build({ romFile: "/emutos.rom" });

const DEFAULT_ROM = path.join(__dirname, "..", "..", "roms", "emutos", "etos192us.img");

// ROM: a .img/.rom argument, PCE_ST_ROM, or the EmuTOS included in the repository.
function romPath() {
  return process.env.PCE_ST_ROM
    || process.argv.find(function (a) { return /\.(img|rom)$/i.test(a); })
    || DEFAULT_ROM;
}

async function createCore(options) {
  const opts = options || {};
  const factory = require(CORE);
  const M = await factory({
    print: function () {},
    printErr: opts.log || function () {},
  });
  M.FS.writeFile("/emutos.rom", fs.readFileSync(opts.rom || romPath()));

  function cstr(text) {
    const n = M.lengthBytesUTF8(text) + 1;
    const p = M._malloc(n);
    M.stringToUTF8(text, p, n);
    return p;
  }

  function withStr(text, fn) {
    const p = cstr(text);
    try { return fn(p); } finally { M._free(p); }
  }

  // Fixed time (2026-01-01 12:00:00 UTC) so that runs are reproducible.
  M._pce_st_set_time(opts.time === undefined ? 1767268800 : opts.time);

  const cfgText = opts.cfg || DEFAULT_CFG;
  const rc = withStr(cfgText, function (p) { return M._pce_st_init(p); });
  if (rc !== 0) throw new Error("pce_st_init failed: " + rc);

  const core = {
    M: M,
    stepFrame: function () { return M._pce_st_step_frame(); },
    stepFrames: function (n) {
      for (let i = 0; i < n; i++) {
        const r = M._pce_st_step_frame();
        if (r !== 0) throw new Error("stepFrame returned " + r);
      }
    },
    stepCycles: function (n) { return M._pce_st_step_cycles(n); },
    clock: function () { return M._pce_st_clock_count(); },
    frame: function () { return M._pce_st_frame_count(); },
    hash: function () { return M.UTF8ToString(M._pce_st_state_hash()); },
    peek8: function (a) { return M._pce_st_peek8(a); },
    poke8: function (a, v) { M._pce_st_poke8(a, v); },
    reg: function (name) { return withStr(name, function (p) { return M._pce_st_reg(p); }); },
    key: function (event, code) { M._pce_st_key(event, code); },
    keyCode: function (name) { return withStr(name, function (p) { return M._pce_st_key_from_name(p); }); },
    setJoystickMode: function (mode) { M._pce_st_set_keypad_joystick(mode); },
    joystickMode: function () { return M._pce_st_get_keypad_joystick(); },
    joystickState: function (port) { return M._pce_st_joystick_state(port); },
    mouse: function (dx, dy, buttons) { M._pce_st_mouse(dx, dy, buttons); },
    // Mounts an image in A: (drive 0) or B: (drive 1) from JS bytes.
    // Eject first: PCE saves the previous floppy to the file if the guest
    // modified it, and that would overwrite the new image if it were already written.
    // `ext` ("st" by default) is the file extension: PCE picks the image format from it.
    mountFloppy: function (drive, bytes, ext) {
      const file = "/disks/fd" + drive + "." + (ext || "st");
      try { M.FS.mkdir("/disks"); } catch (e) { /* ya existe */ }
      core.msg("disk.eject", String(drive));
      M.FS.writeFile(file, bytes);
      return core.msg("disk.insert", file);
    },
    readFloppy: function (drive) { return Buffer.from(M.FS.readFile("/disks/fd" + drive + ".st")); },
    diskFlush: function (drive) { return M._pce_st_disk_flush(drive); },
    diskModified: function (drive) { return M._pce_st_disk_modified(drive) !== 0; },
    msg: function (m, v) {
      return withStr(m, function (pm) {
        return v === undefined || v === null ? M._pce_st_msg(pm, 0) : withStr(v, function (pv) { return M._pce_st_msg(pm, pv); });
      });
    },
    video: function () {
      const w = M._pce_st_video_width();
      const h = M._pce_st_video_height();
      const p = M._pce_st_video_buf();
      return { width: w, height: h, rgb: Buffer.from(M.HEAPU8.subarray(p, p + w * h * 3)) };
    },
    takeAudio: function () {
      const n = M._pce_st_audio_count();
      const p = M._pce_st_audio_buf();
      const out = new Int16Array(n);
      out.set(new Int16Array(M.HEAPU8.buffer, p, n));
      M._pce_st_audio_clear();
      return out;
    },
    audioDropped: function () { return M._pce_st_audio_dropped(); },
  };
  return core;
}

function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

module.exports = { createCore, writePng, DEFAULT_CFG };
