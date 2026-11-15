"use strict";
// Headless automation for PCE_ST: the WASM core driven from Node, with no browser.
// It exposes one grouped API (system, media, input, debug, artifacts) used by the
// MCP server (mcp_server.js), by scripts and by tests.  The machine only advances
// when a call asks for it (run/step), so every run is deterministic: the clock is
// fixed (2026-01-01 12:00 UTC) unless `time` is given.
//
//   const { createHeadlessAutomation } = require("./automation/headless");
//   const auto = await createHeadlessAutomation();
//   await auto.api.system.boot();                 // EmuTOS from roms/emutos
//   await auto.api.system.run({ seconds: 20 });   // emulated seconds
//   const shot = await auto.api.artifacts.captureScreenshot();

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const CORE_JS = path.join(ROOT, "build", "out", "pce_st_core.js");
const DEFAULT_ROM = path.join(ROOT, "roms", "emutos", "etos192us.img");
const CLOCK_HZ = 8000000;                 // clock units per emulated second
const FIXED_TIME = 1767268800;            // 2026-01-01 12:00:00 UTC
const API_VERSION = "1";

const PCE_STConfig = require(path.join(ROOT, "core", "st_config.js"));
const PCE_STImage = require(path.join(ROOT, "web", "js", "core", "st_image.js"));
const PCE_STKeymap = require(path.join(ROOT, "web", "js", "core", "keymap.js"));
const PCE_STSnapshot = require(path.join(ROOT, "web", "js", "core", "snapshot_codec.js"));

// Characters typed by typeText: [KeyboardEvent.code, needs Shift] (US layout, as on the
// on-screen keyboard). Letters and digits are handled separately.
const PUNCTUATION = {
  " ": ["Space", false], "\n": ["Enter", false], "\t": ["Tab", false],
  "-": ["Minus", false], "=": ["Equal", false], "[": ["BracketLeft", false], "]": ["BracketRight", false],
  ";": ["Semicolon", false], "'": ["Quote", false], "\\": ["Backslash", false], ",": ["Comma", false],
  ".": ["Period", false], "/": ["Slash", false], "`": ["Backquote", false],
  "_": ["Minus", true], "+": ["Equal", true], "{": ["BracketLeft", true], "}": ["BracketRight", true],
  ":": ["Semicolon", true], "\"": ["Quote", true], "|": ["Backslash", true], "<": ["Comma", true],
  ">": ["Period", true], "?": ["Slash", true], "~": ["Backquote", true],
  "!": ["Digit1", true], "@": ["Digit2", true], "#": ["Digit3", true], "$": ["Digit4", true],
  "%": ["Digit5", true], "^": ["Digit6", true], "&": ["Digit7", true], "*": ["Digit8", true],
  "(": ["Digit9", true], ")": ["Digit0", true],
};

function fail(message, code) {
  const err = new Error(message);
  err.code = code || "automation_error";
  return err;
}

function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  throw fail("Unsupported binary input", "bad_arguments");
}

// Binary argument: { path } | { base64 } | { bytes }.
function readBinary(args, resolve) {
  if (!args || typeof args !== "object") return null;
  const file = args.path || args.file;
  if (typeof file === "string" && file) return fs.readFileSync(resolve ? resolve(file) : file);
  if (typeof args.base64 === "string") return Buffer.from(args.base64, "base64");
  if (args.bytes !== undefined && args.bytes !== null) return toBuffer(args.bytes);
  return null;
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = function (buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = function (type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function encodeWav(samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function createHeadlessAutomation(options) {
  const opts = options || {};
  const cwd = path.resolve(opts.cwd || process.cwd());
  // With confinePaths every path an action reads or writes must stay inside cwd (also after
  // following symbolic links): the MCP server turns this on.
  const confine = !!opts.confinePaths;
  const resolvePath = function (p) {
    const full = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
    if (!confine) return full;
    const outside = function (root, target) {
      const rel = path.relative(root, target);
      return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
    };
    const realRoot = fs.realpathSync(cwd);
    // The deepest existing ancestor decides (a file to be written does not exist yet).
    let probe = full;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    if (outside(cwd, full) || outside(realRoot, fs.realpathSync(probe))) throw fail("Path is outside the working directory: " + p, "path_denied");
    return full;
  };

  let M = null;                 // the WASM module instance
  let config = null;            // what the machine was booted with
  let romBytes = null;
  let romName = "";
  let timeSetting = FIXED_TIME;
  const floppies = [null, null];   // {name, bytes}
  const pressed = new Set();       // PCE key names currently down
  let joystickOn = false;
  const log = [];

  function requireMachine() {
    if (!M) throw fail("The machine is not booted: call system.boot first", "not_booted");
    return M;
  }

  function withStr(text, fn) {
    const n = M.lengthBytesUTF8(text) + 1;
    const p = M._malloc(n);
    M.stringToUTF8(text, p, n);
    try { return fn(p); } finally { M._free(p); }
  }

  function coreMsg(msg, value) {
    return withStr(msg, function (pm) {
      return value === undefined || value === null ? M._pce_st_msg(pm, 0) : withStr(value, function (pv) { return M._pce_st_msg(pm, pv); });
    });
  }

  function floppyFile(drive) { return "/disks/fd" + drive + ".st"; }

  function mountIntoCore(drive) {
    // Eject first: PCE saves a modified floppy on eject, and that would overwrite the new image.
    coreMsg("disk.eject", String(drive));
    M.FS.writeFile(floppyFile(drive), floppies[drive].bytes);
    return coreMsg("disk.insert", floppyFile(drive));
  }

  function pullFloppy(drive) {
    const f = floppies[drive];
    if (!M || !f) return;
    if (M._pce_st_disk_flush(drive) !== 0) return;
    f.bytes = new Uint8Array(M.FS.readFile(floppyFile(drive)));
  }

  async function startMachine(cfg, snapshotMemory) {
    const factory = require(CORE_JS);
    M = await factory({ print: function () {}, printErr: function (t) { log.push(String(t)); if (log.length > 200) log.shift(); } });
    M.FS.writeFile("/tos.rom", romBytes);
    try { M.FS.mkdir("/disks"); } catch (e) { /* exists */ }
    M._pce_st_set_time(timeSetting);
    const rc = withStr(PCE_STConfig.build({ model: cfg.model, mono: cfg.mono, ramKB: cfg.ramKB, romFile: "/tos.rom" }), function (p) { return M._pce_st_init(p); });
    if (rc !== 0) { M = null; throw fail("pce_st_init failed (" + rc + ")", "boot_failed"); }
    for (let d = 0; d < 2; d++) if (floppies[d]) mountIntoCore(d);
    if (snapshotMemory) {
      if (M.HEAPU8.length !== snapshotMemory.length) throw fail("The snapshot does not match this machine's memory layout", "bad_snapshot");
      M.HEAPU8.set(snapshotMemory);
    }
    pressed.clear();
    if (joystickOn) M._pce_st_set_keypad_joystick(1);
  }

  // ---- durations ----

  // {frames}|{cycles}|{ms}|{seconds}|string ("2s", "500ms", "3frames", "1000cycles") -> clock units
  function toCycles(spec) {
    const frameUnits = config && config.mono ? 112448 : CLOCK_HZ / 60;
    let value = spec;
    if (value && typeof value === "object") {
      if (value.frames !== undefined) return Math.round(Number(value.frames) * frameUnits);
      if (value.cycles !== undefined) return Math.round(Number(value.cycles));
      if (value.ms !== undefined) return Math.round(Number(value.ms) * CLOCK_HZ / 1000);
      if (value.seconds !== undefined) return Math.round(Number(value.seconds) * CLOCK_HZ);
      throw fail("Give frames, cycles, ms or seconds", "bad_arguments");
    }
    if (typeof value === "string") {
      const m = /^\s*([0-9.]+)\s*(frames?|cycles?|ms|s)?\s*$/i.exec(value);
      if (!m) throw fail("Bad duration: " + value, "bad_arguments");
      const n = Number(m[1]);
      const unit = (m[2] || "cycles").toLowerCase();
      if (unit.indexOf("frame") === 0) return Math.round(n * frameUnits);
      if (unit === "ms") return Math.round(n * CLOCK_HZ / 1000);
      if (unit === "s") return Math.round(n * CLOCK_HZ);
      return Math.round(n);
    }
    if (typeof value === "number") return Math.round(value);
    throw fail("Give a duration", "bad_arguments");
  }

  function advance(cycles) {
    requireMachine();
    let left = Math.max(0, Math.floor(cycles / 16) * 16);
    const CHUNK = 1600000;     // 0.2 s: keeps each call to the core short
    while (left > 0) {
      const n = Math.min(left, CHUNK);
      const rc = M._pce_st_step_cycles(n);
      if (rc !== 0) throw fail("The machine stopped", "machine_stopped");
      M._pce_st_audio_clear();
      left -= n;
    }
  }

  // ---- state ----

  function registers() {
    const out = {};
    ["pc", "sr", "usp", "ssp"].forEach(function (n) { out[n] = withStr(n, function (p) { return M._pce_st_reg(p); }); });
    for (let i = 0; i < 8; i++) {
      out["d" + i] = withStr("d" + i, function (p) { return M._pce_st_reg(p); });
      out["a" + i] = withStr("a" + i, function (p) { return M._pce_st_reg(p); });
    }
    return out;
  }

  function floppyInfo(drive) {
    const f = floppies[drive];
    return f ? { name: f.name, size: f.bytes.length, modified: !!(M && M._pce_st_disk_modified(drive)) } : null;
  }

  function darkPercent(v) {
    let dark = 0;
    for (let i = 0; i < v.rgb.length; i += 3) if (v.rgb[i] < 128) dark++;
    return dark * 100 / (v.width * v.height);
  }

  function video() {
    const w = M._pce_st_video_width(), h = M._pce_st_video_height(), p = M._pce_st_video_buf();
    return { width: w, height: h, rgb: Buffer.from(M.HEAPU8.subarray(p, p + w * h * 3)) };
  }

  // ---- the API ----

  const system = {
    // Boots (or restarts) the machine. options: model, mono, ramKB, rom { path | base64 }, time
    // ("real" or Unix seconds). Floppies already mounted stay mounted.
    boot: async function (o) {
      const a = o || {};
      let bytes = readBinary(a.rom, resolvePath);
      if (bytes) romName = a.rom.path ? path.basename(a.rom.path) : "custom";
      if (!bytes && !romBytes) { bytes = fs.readFileSync(DEFAULT_ROM); romName = "EmuTOS"; }
      if (bytes) {
        if (bytes.length !== 192 * 1024) throw fail("The ROM must be a 192K image (got " + bytes.length + " bytes)", "bad_rom");
        romBytes = bytes;
      }
      if (a.time !== undefined) timeSetting = a.time === "real" ? -1 : Number(a.time);
      config = {
        model: a.model || (config && config.model) || "st",
        mono: a.mono !== undefined ? !!a.mono : config ? config.mono : true,
        ramKB: Number(a.ramKB || (config && config.ramKB) || 1024),
      };
      if (M) for (let d = 0; d < 2; d++) pullFloppy(d);
      await startMachine(config);
      return system.getState();
    },
    reset: function () {
      requireMachine();
      for (let d = 0; d < 2; d++) pullFloppy(d);
      M._pce_st_reset();
      pressed.clear();
      return system.getState();
    },
    // Advances emulated time: { frames } | { ms } | { seconds } | { cycles } (or a duration string).
    run: function (o) {
      requireMachine();
      const target = toCycles(o);
      advance(target);
      return { advancedCycles: target, state: system.getState() };
    },
    getState: function () {
      if (!M) return { booted: false };
      return {
        booted: true,
        apiVersion: API_VERSION,
        config: Object.assign({}, config),
        rom: romName,
        clock: M._pce_st_clock_count(),
        seconds: M._pce_st_clock_count() / CLOCK_HZ,
        frame: M._pce_st_frame_count(),
        video: { width: M._pce_st_video_width(), height: M._pce_st_video_height() },
        hash: M.UTF8ToString(M._pce_st_state_hash()),
        registers: registers(),
        floppies: { A: floppyInfo(0), B: floppyInfo(1) },
        joystick: { enabled: joystickOn, port1: M._pce_st_joystick_state(1) },
        keysDown: Array.from(pressed),
      };
    },
    getCapabilities: function () {
      return {
        apiVersion: API_VERSION,
        groups: ["system", "media", "input", "debug", "artifacts"],
        actions: { system: Object.keys(system), media: Object.keys(media), input: Object.keys(input), debug: Object.keys(debug), artifacts: Object.keys(artifacts) },
        formats: ["st", "msa", "prg"],
        models: ["st", "mega"],
        deterministic: true,
        node: process.version,
      };
    },
    // Recent lines the core printed to its error stream.
    getLog: function () { return log.slice(); },
  };

  const media = {
    // Mounts a floppy in A: or B:. { drive: "A"|"B"|0|1, path | base64, name }.
    // .msa is converted to .st; .prg is wrapped in a generated floppy.
    mountFloppy: function (a) {
      const drive = parseDrive(a && a.drive);
      let bytes = readBinary(a, resolvePath);
      if (!bytes) throw fail("Give path, base64 or bytes", "bad_arguments");
      const name = a.name || (a.path ? path.basename(a.path) : "disk.st");
      const lower = name.toLowerCase();
      let outName = name;
      if (lower.endsWith(".prg")) { bytes = Buffer.from(PCE_STImage.createFloppy({ files: [{ name: name, data: bytes }] })); outName = name.replace(/\.prg$/i, ".st"); }
      else if (lower.endsWith(".msa")) { bytes = Buffer.from(PCE_STImage.decodeMsa(new Uint8Array(bytes))); outName = name.replace(/\.msa$/i, ".st"); }
      if (bytes.length % 512 !== 0 || bytes.length < 512) throw fail("A floppy image is a multiple of 512 bytes", "bad_image");
      if (M) pullFloppy(drive);
      floppies[drive] = { name: outName, bytes: new Uint8Array(bytes) };
      if (M) { const rc = mountIntoCore(drive); if (rc !== 0) throw fail("The machine did not accept the floppy (" + rc + ")", "mount_failed"); }
      return { drive: "AB"[drive], floppy: floppyInfo(drive) };
    },
    // Builds a 720K floppy from files { files: [{ name, path | base64 }], label, drive }; this
    // is the "work files" disk: loose programs and data next to each other.
    buildFloppy: function (a) {
      const files = (a && a.files || []).map(function (f) {
        const data = readBinary(f, resolvePath);
        if (!data) throw fail("Each file needs path or base64", "bad_arguments");
        return { name: f.name || path.basename(f.path || "file.bin"), data: data };
      });
      if (!files.length) throw fail("Give at least one file", "bad_arguments");
      const image = Buffer.from(PCE_STImage.createFloppy({ label: a.label || "WORK", files: files }));
      if (a.drive !== undefined) return media.mountFloppy({ drive: a.drive, bytes: image, name: a.name || "work.st" });
      return { size: image.length, base64: image.toString("base64") };
    },
    ejectFloppy: function (a) {
      const drive = parseDrive(a && a.drive);
      if (M) pullFloppy(drive);
      const f = floppies[drive];
      floppies[drive] = null;
      if (M) coreMsg("disk.eject", String(drive));
      return { drive: "AB"[drive], ejected: !!f };
    },
    // The current image of a floppy (with the guest's changes). Writes it to `out` if given.
    readFloppy: function (a) {
      const drive = parseDrive(a && a.drive);
      if (M) pullFloppy(drive);
      const f = floppies[drive];
      if (!f) throw fail("No floppy in " + "AB"[drive] + ":", "no_floppy");
      const buffer = Buffer.from(f.bytes);
      if (a.out) fs.writeFileSync(resolvePath(a.out), buffer);
      return { drive: "AB"[drive], name: f.name, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), bytes: a.out ? undefined : buffer };
    },
    // Lists a folder of the floppy's FAT12 file system. { drive, folder: "SUB/DIR" }
    listFiles: function (a) {
      const volume = openVolumeOf(parseDrive(a && a.drive));
      const entries = walkFolder(volume, a && a.folder);
      return { label: volume.label, entries: entries.map(function (e) { return { name: e.name, isDir: e.isDir, size: e.size }; }) };
    },
    // Reads a file from the floppy. { drive, path: "SUB/FILE.TXT", asText }
    readFile: function (a) {
      const volume = openVolumeOf(parseDrive(a && a.drive));
      const parts = String(a && a.path || "").split(/[\\/]/).filter(Boolean);
      if (!parts.length) throw fail("Give a file path", "bad_arguments");
      const entries = walkFolder(volume, parts.slice(0, -1).join("/"));
      const entry = entries.find(function (e) { return e.name.toUpperCase() === parts[parts.length - 1].toUpperCase(); });
      if (!entry) throw fail("File not found: " + a.path, "not_found");
      const data = Buffer.from(volume.read(entry));
      return a.asText ? { name: entry.name, size: data.length, text: data.toString("latin1") } : { name: entry.name, size: data.length, bytes: data };
    },
    // The guest's unsaved changes are written to the floppy image.
    flushFloppy: function (a) {
      const drive = parseDrive(a && a.drive);
      requireMachine();
      pullFloppy(drive);
      return floppyInfo(drive);
    },
  };

  function parseDrive(value) {
    if (value === 0 || value === "0" || String(value).toUpperCase() === "A" || String(value).toUpperCase() === "A:") return 0;
    if (value === 1 || value === "1" || String(value).toUpperCase() === "B" || String(value).toUpperCase() === "B:") return 1;
    if (value === undefined) return 0;
    throw fail("Drive must be A or B", "bad_arguments");
  }

  function openVolumeOf(drive) {
    if (M) pullFloppy(drive);
    const f = floppies[drive];
    if (!f) throw fail("No floppy in " + "AB"[drive] + ":", "no_floppy");
    const volume = PCE_STImage.openVolume(f.bytes);
    if (!volume) throw fail("The floppy has no FAT12 file system", "no_filesystem");
    return volume;
  }

  function walkFolder(volume, folder) {
    let entries = volume.list(0);
    String(folder || "").split(/[\\/]/).filter(Boolean).forEach(function (part) {
      const next = entries.find(function (e) { return e.isDir && e.name.toUpperCase() === part.toUpperCase(); });
      if (!next) throw fail("Folder not found: " + folder, "not_found");
      entries = volume.list(next.cluster);
    });
    return entries;
  }

  // ---- input ----

  function pceKey(name) {
    const mapped = PCE_STKeymap.pceKeyName(name);
    const key = mapped || name;
    const code = withStr(key, function (p) { return M._pce_st_key_from_name(p); });
    if (!code) throw fail("Unknown key: " + name, "bad_arguments");
    return { key: key, code: code };
  }

  function keyEvent(name, down) {
    const k = pceKey(name);
    M._pce_st_key(down ? 1 : 2, k.code);
    if (down) pressed.add(k.key); else pressed.delete(k.key);
  }

  function charKey(ch) {
    if (/[a-z]/.test(ch)) return ["Key" + ch.toUpperCase(), false];
    if (/[A-Z]/.test(ch)) return ["Key" + ch, true];
    if (/[0-9]/.test(ch)) return ["Digit" + ch, false];
    if (Object.prototype.hasOwnProperty.call(PUNCTUATION, ch)) return PUNCTUATION[ch];
    throw fail("Cannot type the character " + JSON.stringify(ch), "bad_arguments");
  }

  const holdCycles = function (o, def) { return toCycles(o !== undefined ? o : def); };

  const input = {
    // { key: "KeyA" | "Enter" | PCE name, action: "press" | "release" | "tap", hold: duration }
    key: function (a) {
      requireMachine();
      const action = (a && a.action) || "tap";
      if (action === "press") keyEvent(a.key, true);
      else if (action === "release") keyEvent(a.key, false);
      else if (action === "tap") {
        keyEvent(a.key, true);
        advance(holdCycles(a.hold, { frames: 4 }));
        keyEvent(a.key, false);
        advance(holdCycles(a.after, { frames: 4 }));
      } else throw fail("action is press, release or tap", "bad_arguments");
      return { keysDown: Array.from(pressed) };
    },
    // Types text on the US layout. { text, hold, gap } (durations; default 4 frames each).
    typeText: function (a) {
      requireMachine();
      const text = String(a && a.text !== undefined ? a.text : "");
      for (const ch of text) {
        const k = charKey(ch);
        if (k[1]) { keyEvent("ShiftLeft", true); advance(toCycles({ frames: 2 })); }
        keyEvent(k[0], true);
        advance(holdCycles(a.hold, { frames: 4 }));
        keyEvent(k[0], false);
        if (k[1]) keyEvent("ShiftLeft", false);
        advance(holdCycles(a.gap, { frames: 4 }));
      }
      return { typed: text.length };
    },
    // Relative mouse motion and buttons: { dx, dy, buttons } (bit 0 left, 1 right).
    mouse: function (a) {
      requireMachine();
      M._pce_st_mouse((a.dx | 0), (a.dy | 0), (a.buttons | 0));
      if (a.after !== undefined) advance(toCycles(a.after));
      return { ok: true };
    },
    // { button: "left" | "right", hold, double }
    click: function (a) {
      requireMachine();
      const bit = (a && a.button) === "right" ? 2 : 1;
      const times = a && a.double ? 2 : 1;
      for (let i = 0; i < times; i++) {
        M._pce_st_mouse(0, 0, bit);
        advance(holdCycles(a && a.hold, { frames: 2 }));
        M._pce_st_mouse(0, 0, 0);
        advance(holdCycles(a && a.gap, { frames: 3 }));
      }
      return { ok: true };
    },
    // Moves the pointer by many small steps. { dx, dy } total.
    moveMouse: function (a) {
      requireMachine();
      let dx = a.dx | 0, dy = a.dy | 0;
      while (dx || dy) {
        const sx = Math.max(-50, Math.min(50, dx)), sy = Math.max(-28, Math.min(28, dy));
        M._pce_st_mouse(sx, sy, 0);
        dx -= sx; dy -= sy;
        advance(toCycles({ frames: 2 }));
      }
      return { ok: true };
    },
    // Joystick in port 1: { up, down, left, right, fire } (the keypad drives it, as in PCE).
    joystick: function (a) {
      requireMachine();
      if (!joystickOn) { joystickOn = true; M._pce_st_set_keypad_joystick(1); }
      const map = { up: "Numpad8", down: "Numpad2", left: "Numpad4", right: "Numpad6", fire: "Numpad0" };
      Object.keys(map).forEach(function (name) { if (a[name] !== undefined) keyEvent(map[name], !!a[name]); });
      if (a.hold !== undefined) advance(toCycles(a.hold));
      return { port1: M._pce_st_joystick_state(1) };
    },
    releaseAll: function () {
      requireMachine();
      Array.from(pressed).forEach(function (key) { const k = pceKey(key); M._pce_st_key(2, k.code); });
      pressed.clear();
      M._pce_st_mouse(0, 0, 0);
      return { ok: true };
    },
  };

  const debug = {
    peek: function (a) { requireMachine(); return { value: M._pce_st_peek8(Number(a.address)) }; },
    poke: function (a) { requireMachine(); M._pce_st_poke8(Number(a.address), Number(a.value) & 0xff); return { ok: true }; },
    // { address, length } -> bytes (max 64K).
    readMemory: function (a) {
      requireMachine();
      const length = Math.min(Number(a.length) || 1, 65536);
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i++) out[i] = M._pce_st_peek8((Number(a.address) + i) & 0xffffff);
      return { address: Number(a.address), length: length, bytes: out };
    },
    writeMemory: function (a) {
      requireMachine();
      const data = readBinary(a, resolvePath);
      if (!data) throw fail("Give base64, bytes or path", "bad_arguments");
      for (let i = 0; i < data.length; i++) M._pce_st_poke8((Number(a.address) + i) & 0xffffff, data[i]);
      return { written: data.length };
    },
    getRegisters: function () { requireMachine(); return registers(); },
    getStateHash: function () { requireMachine(); return { hash: M.UTF8ToString(M._pce_st_state_hash()) }; },
    // Runs until a byte (or masked byte) at an address has a value, up to maxFrames.
    // { address, value, mask, maxFrames } -> { matched, frames }
    runUntilMemory: function (a) {
      requireMachine();
      const mask = a.mask === undefined ? 0xff : Number(a.mask);
      const limit = Number(a.maxFrames || 600);
      for (let i = 0; i <= limit; i++) {
        if ((M._pce_st_peek8(Number(a.address)) & mask) === (Number(a.value) & mask)) return { matched: true, frames: i };
        if (i < limit) advance(toCycles({ frames: 1 }));
      }
      return { matched: false, frames: limit };
    },
    // Runs until the screen stops changing for `stableFrames` frames and (optionally) at
    // least minDarkPercent of the pixels are dark: the EmuTOS desktop in monochrome is ~48 %.
    // { stableFrames, maxFrames, minDarkPercent }
    runUntilStable: function (a) {
      requireMachine();
      const need = Number(a && a.stableFrames || 30), limit = Number(a && a.maxFrames || 3000);
      let last = null, same = 0;
      for (let i = 0; i < limit; i++) {
        advance(toCycles({ frames: 1 }));
        const v = video();
        const h = crypto.createHash("md5").update(v.rgb).digest("hex");
        same = h === last ? same + 1 : 0;
        last = h;
        if (same >= need && (!a || !a.minDarkPercent || darkPercent(v) >= a.minDarkPercent)) return { stable: true, frames: i + 1 };
      }
      return { stable: false, frames: limit };
    },
  };

  const artifacts = {
    // Returns the PNG (and writes it to `out` if given), with a hash of the pixels.
    captureScreenshot: function (a) {
      requireMachine();
      const v = video();
      const png = encodePng(v.width, v.height, v.rgb);
      if (a && a.out) fs.writeFileSync(resolvePath(a.out), png);
      let dark = 0;
      for (let i = 0; i < v.rgb.length; i += 3) if (v.rgb[i] < 128) dark++;
      return {
        width: v.width, height: v.height,
        sha256: crypto.createHash("sha256").update(v.rgb).digest("hex"),
        darkPixelPercent: Math.round(dark * 1000 / (v.width * v.height)) / 10,
        png: a && a.out ? undefined : png,
        path: a && a.out ? resolvePath(a.out) : undefined,
      };
    },
    // Audio produced while running is dropped by run(); this captures `duration` of it as a WAV.
    captureAudio: function (a) {
      requireMachine();
      const total = toCycles(a || { seconds: 1 });
      const chunks = [];
      let left = Math.floor(total / 16) * 16;
      while (left > 0) {
        const n = Math.min(left, 160000);
        if (M._pce_st_step_cycles(n) !== 0) throw fail("The machine stopped", "machine_stopped");
        const count = M._pce_st_audio_count(), p = M._pce_st_audio_buf();
        const part = new Int16Array(count);
        part.set(new Int16Array(M.HEAPU8.buffer, p, count));
        chunks.push(part);
        M._pce_st_audio_clear();
        left -= n;
      }
      const samples = new Int16Array(chunks.reduce(function (s, c) { return s + c.length; }, 0));
      let off = 0;
      chunks.forEach(function (c) { samples.set(c, off); off += c.length; });
      let peak = 0;
      samples.forEach(function (s) { peak = Math.max(peak, Math.abs(s)); });
      const wav = encodeWav(samples, M._pce_st_audio_rate());
      if (a && a.out) fs.writeFileSync(resolvePath(a.out), wav);
      return { samples: samples.length, rate: M._pce_st_audio_rate(), peak: peak, wav: a && a.out ? undefined : wav, path: a && a.out ? resolvePath(a.out) : undefined };
    },
    // A snapshot (memory + floppies) as a .pcestsnap file's bytes; compatible with the browser.
    saveSnapshot: async function (a) {
      requireMachine();
      for (let d = 0; d < 2; d++) pullFloppy(d);
      const bytes = await PCE_STSnapshot.encode({
        config: Object.assign({}, config), romLabel: romName,
        memory: new Uint8Array(M.HEAPU8), floppies: floppies.map(function (f) { return f ? { name: f.name, bytes: f.bytes } : null; }),
      });
      if (a && a.out) fs.writeFileSync(resolvePath(a.out), bytes);
      return { size: bytes.length, path: a && a.out ? resolvePath(a.out) : undefined, bytes: a && a.out ? undefined : Buffer.from(bytes) };
    },
    loadSnapshot: async function (a) {
      const data = readBinary(a, resolvePath);
      if (!data) throw fail("Give path, base64 or bytes", "bad_arguments");
      const decoded = await PCE_STSnapshot.decode(new Uint8Array(data));
      config = Object.assign({}, decoded.snapshot.config);
      decoded.snapshot.floppies.forEach(function (f, d) { floppies[d] = f ? { name: f.name, bytes: f.bytes } : null; });
      await startMachine(config, decoded.snapshot.memory);
      return system.getState();
    },
  };

  return {
    api: { apiVersion: API_VERSION, system: system, media: media, input: input, debug: debug, artifacts: artifacts },
    dispose: function () { M = null; },
  };
}

module.exports = { createHeadlessAutomation, API_VERSION, encodePng };
