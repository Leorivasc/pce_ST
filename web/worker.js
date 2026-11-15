/* global self, importScripts, PCE_STCoreFactory, PCE_STConfig, PCE_STKeymap */
// Emulation thread: loads the WASM core, advances the machine at real-time
// pace (or faster) and delivers video (OffscreenCanvas) and audio (a port to
// the AudioWorklet).
"use strict";

importScripts("../build/out/pce_st_core.js", "../core/st_config.js", "keymap.js");

const ST_CPU_CLOCK = 8000000;
const MAX_CATCHUP_MS = 100;   // like PCE: never emulate more than 100 ms in one go
const TURBO_WORK_MS = 12;     // at maximum turbo: working time per tick

let core = null;              // { M, ... } ver createCore
let ctx2d = null;
let canvas = null;
let audioPort = null;
let imageData = null;
let running = false;
let speed = 1;                // 1 = real time, N = N times, 0 = as fast as possible
let timer = 0;
let lastTick = 0;
let budgetMs = 0;
let lastDrawnFrame = -1;
let keyCache = Object.create(null);
let stats = { windowStart: 0, frames: 0, emulatedMs: 0 };
let sampleRate = 48000;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function withStr(M, text, fn) {
  const n = M.lengthBytesUTF8(text) + 1;
  const p = M._malloc(n);
  M.stringToUTF8(text, p, n);
  try { return fn(p); } finally { M._free(p); }
}

async function createCore(config, romBytes) {
  const M = await PCE_STCoreFactory({
    // The .wasm sits next to the core's JS, not next to this worker.
    locateFile: function (file) { return "../build/out/" + file; },
    print: function (t) { post({ type: "log", text: t }); },
    printErr: function (t) { post({ type: "log", text: t }); },
  });
  M.FS.writeFile("/tos.rom", romBytes);
  M._pce_st_set_time(-1); // real time
  const rc = withStr(M, config, function (p) { return M._pce_st_init(p); });
  if (rc !== 0) throw new Error("pce_st_init failed: " + rc);
  return M;
}

function drawVideo() {
  const M = core;
  const frame = M._pce_st_frame_count();
  if (frame === lastDrawnFrame) return;
  lastDrawnFrame = frame;
  const w = M._pce_st_video_width();
  const h = M._pce_st_video_height();
  if (!w || !h) return;
  if (!imageData || imageData.width !== w || imageData.height !== h) {
    canvas.width = w;
    canvas.height = h;
    imageData = ctx2d.createImageData(w, h);
    post({ type: "videoSize", width: w, height: h });
  }
  const src = M.HEAPU8.subarray(M._pce_st_video_buf(), M._pce_st_video_buf() + w * h * 3);
  const dst = imageData.data;
  for (let i = 0, j = 0, n = w * h; i < n; i++, j += 3) {
    dst[i * 4] = src[j];
    dst[i * 4 + 1] = src[j + 1];
    dst[i * 4 + 2] = src[j + 2];
    dst[i * 4 + 3] = 255;
  }
  ctx2d.putImageData(imageData, 0, 0);
}

function sendAudio() {
  const M = core;
  const n = M._pce_st_audio_count();
  if (n === 0) return;
  if (audioPort && speed === 1) {
    const out = new Int16Array(n);
    out.set(new Int16Array(M.HEAPU8.buffer, M._pce_st_audio_buf(), n));
    audioPort.postMessage(out, [out.buffer]);
  }
  M._pce_st_audio_clear();
}

function tick() {
  timer = 0;
  if (!running || !core) return;
  const M = core;
  const now = performance.now();
  let dt = now - lastTick;
  lastTick = now;
  if (dt > MAX_CATCHUP_MS) dt = MAX_CATCHUP_MS;

  const startClock = M._pce_st_clock_count();
  let framesRun = 0;

  if (speed === 0) {
    // Maximum speed: as much as fits in the working time.
    while (performance.now() - now < TURBO_WORK_MS) {
      if (M._pce_st_step_frame() !== 0) break;
      framesRun++;
    }
  } else {
    budgetMs += dt * speed;
    while (budgetMs > 0) {
      const before = M._pce_st_clock_count();
      if (M._pce_st_step_frame() !== 0) break;
      budgetMs -= (M._pce_st_clock_count() - before) / (ST_CPU_CLOCK / 1000);
      framesRun++;
      if (performance.now() - now > 50) { budgetMs = 0; break; } // do not choke the thread
    }
    if (budgetMs > 2 * MAX_CATCHUP_MS) budgetMs = 0;
  }

  drawVideo();
  sendAudio();

  stats.frames += framesRun;
  stats.emulatedMs += (M._pce_st_clock_count() - startClock) / (ST_CPU_CLOCK / 1000);
  const elapsed = now - stats.windowStart;
  if (elapsed >= 500) {
    post({
      type: "stats",
      fps: stats.frames * 1000 / elapsed,
      speed: stats.emulatedMs / elapsed,
      width: M._pce_st_video_width(),
      height: M._pce_st_video_height(),
      clock: M._pce_st_clock_count(),
    });
    stats = { windowStart: now, frames: 0, emulatedMs: 0 };
  }
  schedule();
}

function schedule() {
  if (!timer && running) timer = setTimeout(tick, 1);
}

function setRunning(value) {
  running = !!value;
  if (running) {
    lastTick = performance.now();
    stats = { windowStart: lastTick, frames: 0, emulatedMs: 0 };
    budgetMs = 0;
    schedule();
  }
  post({ type: "running", running: running });
}

// Sends a PCE message ("disk.insert", "emu.pause", ...). Returns 0 if accepted.
function coreMsg(name, value) {
  return withStr(core, name, function (pn) {
    if (value === undefined || value === null) return core._pce_st_msg(pn, 0);
    return withStr(core, String(value), function (pv) { return core._pce_st_msg(pn, pv); });
  });
}

function keyCode(name) {
  if (!(name in keyCache)) {
    keyCache[name] = withStr(core, name, function (p) { return core._pce_st_key_from_name(p); });
  }
  return keyCache[name];
}

function floppyBytes(drive) {
  try { return core.FS.readFile("/disks/fd" + drive + ".st"); } catch (e) { return null; }
}

self.onmessage = async function (ev) {
  const m = ev.data;
  try {
    switch (m.type) {
      case "init": {
        setRunning(false);
        canvas = m.canvas || canvas;
        ctx2d = canvas.getContext("2d", { alpha: false });
        imageData = null;
        lastDrawnFrame = -1;
        keyCache = Object.create(null);
        sampleRate = m.sampleRate || 48000;
        if (m.audioPort) audioPort = m.audioPort;
        core = null;
        const cfg = PCE_STConfig.build({ mono: m.mono !== false, sampleRate: sampleRate });
        core = await createCore(cfg, new Uint8Array(m.rom));
        post({ type: "ready" });
        if (m.autostart !== false) setRunning(true);
        break;
      }
      case "run": setRunning(m.run); break;
      case "screenshot": {
        if (!core) break;
        const w = core._pce_st_video_width(), h = core._pce_st_video_height();
        const p = core._pce_st_video_buf();
        const rgb = core.HEAPU8.slice(p, p + w * h * 3).buffer;
        post({ type: "screenshot", id: m.id, width: w, height: h, rgb: rgb }, [rgb]);
        break;
      }
      case "peek": {
        if (!core) break;
        const out = new Uint8Array(m.length | 0);
        for (let i = 0; i < out.length; i++) out[i] = core._pce_st_peek8((m.addr + i) >>> 0);
        post({ type: "memory", id: m.id, bytes: out.buffer }, [out.buffer]);
        break;
      }
      case "poke":
        if (core) core._pce_st_poke8(m.addr, m.value);
        break;
      case "reset": if (core) { core._pce_st_reset(); } break;
      case "speed": speed = m.speed; budgetMs = 0; break;
      case "key": {
        if (!core) break;
        const name = PCE_STKeymap.pceKeyName(m.code);
        if (!name) break;
        const k = keyCode(name);
        if (k) core._pce_st_key(m.down ? 1 : 2, k);
        break;
      }
      case "mouse":
        if (core) core._pce_st_mouse(m.dx | 0, m.dy | 0, m.buttons | 0);
        break;
      case "mount": {
        if (!core) break;
        try { core.FS.mkdir("/disks"); } catch (e) { /* already exists */ }
        const file = "/disks/fd" + m.drive + ".st";
        // Eject first: PCE saves the previous floppy to the file if the guest
        // modified it, and that would overwrite the new image if it were already written.
        coreMsg("disk.eject", m.drive);
        core.FS.writeFile(file, new Uint8Array(m.bytes));
        const rc = coreMsg("disk.insert", file);
        post({ type: "mounted", drive: m.drive, rc: rc });
        break;
      }
      case "flush": {
        if (!core) break;
        const rc = core._pce_st_disk_flush(m.drive);
        const bytes = floppyBytes(m.drive);
        const copy = bytes ? bytes.slice().buffer : null;
        post({ type: "floppy", drive: m.drive, rc: rc, bytes: copy }, copy ? [copy] : []);
        break;
      }
      default: break;
    }
  } catch (err) {
    post({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
