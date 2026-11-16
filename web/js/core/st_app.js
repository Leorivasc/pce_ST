// PCE_STApp: the machine as the shell sees it. It runs inside the emulation
// worker and wraps the WASM core (pce_st_core) with: the run loop at real-time
// pace (or faster), video rendering, audio output, keyboard/mouse input, floppy
// media, snapshots and debugging access. The main thread talks to it through
// js/core/app_proxy.js and emulator_worker.js.
//
// Usage (inside the worker):
//   const app = await PCE_STApp.create({ canvas, audioPort, rom, config, onEvent });
//   app.start();
(function (root) {
  "use strict";

  const ST_CPU_CLOCK = 8000000;        // clock units per emulated second
  const MAX_CATCHUP_MS = 100;          // like PCE: never emulate more than 100 ms at once
  const MAX_WORK_MS = 50;              // cut a tick short after this much work
  const TURBO_WORK_MS = 12;            // working time per tick at maximum speed
  const STATS_INTERVAL_MS = 500;
  const TURBO_PAINT_INTERVAL_MS = 100;  // at maximum speed the picture is refreshed 10 times a second
  const DEFAULT_CONFIG = { model: "st", mono: true, ramKB: 1024 };

  function withStr(M, text, fn) {
    const n = M.lengthBytesUTF8(text) + 1;
    const p = M._malloc(n);
    M.stringToUTF8(text, p, n);
    try { return fn(p); } finally { M._free(p); }
  }

  function toBytes(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return Uint8Array.from(data);
    return null;
  }

  async function create(opts) {
    const options = opts || {};
    const emit = typeof options.onEvent === "function" ? options.onEvent : function () {};
    const canvas = options.canvas;
    let audioPort = options.audioPort || null;
    let rom = toBytes(options.rom);
    let config = Object.assign({}, DEFAULT_CONFIG, options.config || {});

    let M = null;                      // the core module instance
    let renderer = null;
    let running = false;
    let turbo = !!options.turbo;
    let audioEnabled = options.audioEnabled !== false;
    let joystickEnabled = !!options.joystick;   // PCE's keypad joystick emulation (port 1)
    const joystickDown = {};                     // keypad keys currently held by the joystick
    let crtEnabled = options.crtEnabled !== false;
    let timer = 0;
    let lastTick = 0;
    let budgetMs = 0;
    let lastDrawnFrame = -1;
    let bootToken = 0;
    let keyCache = Object.create(null);
    let stats = { windowStart: 0, frames: 0, emulatedMs: 0 };
    let lastStats = null;
    let disposed = false;
    const floppies = [null, null];     // { name, bytes } for A: and B:

    // ---- state reporting ----

    function snapshotState() {
      return {
        ready: !!M,
        running: running,
        turbo: turbo,
        audioEnabled: audioEnabled,
        joystick: joystickEnabled,
        crtEnabled: crtEnabled,
        romLoaded: !!rom,
        config: Object.assign({}, config),
        video: M ? { width: M._pce_st_video_width(), height: M._pce_st_video_height() } : { width: 0, height: 0 },
        backend: renderer ? renderer.backend : "none",
        floppies: floppies.map(function (f, drive) {
          if (!f) return null;
          return { name: f.name, size: f.bytes.length, modified: !!(M && M._pce_st_disk_modified(drive)) };
        }),
      };
    }

    let lastModified = "";
    function emitState() { emit({ type: "state", state: snapshotState() }); }

    // ---- renderer ----

    async function createRenderer() {
      if (renderer) renderer.dispose();
      renderer = null;
      if (!canvas) return;
      try {
        await root.PCE_STGlRenderer.loadShaderSources();
        renderer = root.PCE_STGlRenderer.create({ canvas: canvas, crtEnabled: crtEnabled });
      } catch (err) {
        emit({ type: "log", text: "WebGL2 renderer unavailable, using Canvas 2D: " + err.message });
        renderer = root.PCE_STSoftwareRenderer.create({ canvas: canvas });
      }
    }

    function paint() {
      if (!M || !renderer) return;
      const w = M._pce_st_video_width();
      const h = M._pce_st_video_height();
      if (!w || !h) return;
      const p = M._pce_st_video_buf();
      renderer.paint(M.HEAPU8.subarray(p, p + w * h * 3), w, h);
    }

    // Tells the page which drives the floppy controller worked on (for the drive LEDs).
    function reportActivity() {
      const act = M._pce_st_disk_activity();
      if (!act) return;
      for (let d = 0; d < 2; d++) {
        if (act & (3 << (d * 2))) emit({ type: "activity", activity: { deviceSlot: d, operation: (act >> (d * 2)) & 2 ? "write" : "read" } });
      }
    }

    let lastPaintAt = 0;

    // Draws the last frame if it is new. Painting is decoupled from emulation: at
    // maximum speed it is throttled, because a CRT-filtered frame costs far more
    // than emulating it (especially with software WebGL).
    function drawIfNew() {
      const frame = M._pce_st_frame_count();
      if (frame === lastDrawnFrame) return;
      const now = performance.now();
      if (turbo && now - lastPaintAt < TURBO_PAINT_INTERVAL_MS) return;
      lastPaintAt = now;
      lastDrawnFrame = frame;
      paint();
    }

    // ---- core lifecycle ----

    // TOS notices a disk change through the drive's write-protect line, which must stay up
    // for a while with the drive empty (see pce_st_disk_hold_empty in st_glue.c). Every
    // eject records when the drive became empty; inserting waits (in emulated time) until the
    // drive has been empty for SWAP_GAP_CYCLES.
    const CORE_API_VERSION = 4;           // see pce_st_api_version in st_glue.c
    const SWAP_GAP_CYCLES = 4000000;      // 0.5 s of emulated time
    const emptySince = [-1, -1];

    function ejectFromCore(drive) {
      coreMsg("disk.eject", String(drive));
      M._pce_st_disk_hold_empty(drive);
      emptySince[drive] = M._pce_st_clock_count();
    }

    function mountIntoCore(drive, swap) {
      const f = floppies[drive];
      if (!M || !f) return 1;
      try { M.FS.mkdir("/disks"); } catch (e) { /* already exists */ }
      const file = "/disks/fd" + drive + ".st";
      // Eject first: PCE saves the previous floppy to the file if the guest
      // modified it, and that would overwrite the new image if already written.
      // (The eject also selects the drive the following insert goes to.)
      if (swap) ejectFromCore(drive); else coreMsg("disk.eject", String(drive));
      if (swap || emptySince[drive] >= 0) {
        const waited = M._pce_st_clock_count() - emptySince[drive];
        if (waited < SWAP_GAP_CYCLES) {
          // Run the machine (not rendered or heard) through the rest of the gap.
          M._pce_st_step_cycles(Math.ceil((SWAP_GAP_CYCLES - waited) / 16) * 16);
          M._pce_st_audio_clear();
        }
      }
      emptySince[drive] = -1;
      M.FS.writeFile(file, f.bytes);
      return coreMsg("disk.insert", file);
    }

    function coreMsg(name, value) {
      return withStr(M, name, function (pn) {
        if (value === undefined || value === null) return M._pce_st_msg(pn, 0);
        return withStr(M, String(value), function (pv) { return M._pce_st_msg(pn, pv); });
      });
    }

    // Saves the guest's changes to a floppy into floppies[drive].bytes.
    function pullFloppy(drive) {
      const f = floppies[drive];
      if (!M || !f) return;
      let r = M._pce_st_disk_flush(drive), stepped = false;
      // Busy controller (TOS is in the middle of a transfer): let the command finish first.
      for (let i = 0; r === 2 && i < 200; i++) { M._pce_st_step_cycles(16000); stepped = true; r = M._pce_st_disk_flush(drive); }
      if (stepped) M._pce_st_audio_clear();
      if (r !== 0) return;
      try { f.bytes = new Uint8Array(M.FS.readFile("/disks/fd" + drive + ".st")); } catch (e) { /* keep the old bytes */ }
    }

    function disposeCore() {
      emptySince[0] = emptySince[1] = -1;
      M = null;
      lastDrawnFrame = -1;
    }

    async function bootCore() {
      const token = ++bootToken;
      for (let d = 0; d < 2; d++) pullFloppy(d);
      disposeCore();
      if (!rom) { emitState(); return false; }
      const module = await root.PCE_STCoreFactory({
        locateFile: function (file) { return "../build/out/" + file; },
        print: function (t) { emit({ type: "log", text: t }); },
        printErr: function (t) { emit({ type: "log", text: t }); },
      });
      if (token !== bootToken || disposed) return false;
      if (typeof module._pce_st_api_version !== "function" || module._pce_st_api_version() !== CORE_API_VERSION) {
        throw new Error("The emulator core (pce_st_core.wasm) does not match this page: it is a different version " +
          "(a cached or not republished file). Reload ignoring the cache (Ctrl+Shift+R) or republish build/out/.");
      }
      module.FS.writeFile("/tos.rom", rom);
      module._pce_st_set_time(-1);                       // real time
      const rc = withStr(module, root.PCE_STConfig.build({
        model: config.model, mono: config.mono, ramKB: config.ramKB, sampleRate: 48000,
      }), function (p) { return module._pce_st_init(p); });
      if (rc !== 0) throw new Error("pce_st_init failed: " + rc);
      M = module;
      module._pce_st_set_keypad_joystick(joystickEnabled ? 1 : 0);
      Object.keys(joystickDown).forEach(function (k) { delete joystickDown[k]; });
      keyCache = Object.create(null);
      budgetMs = 0;
      for (let d = 0; d < 2; d++) if (floppies[d]) mountIntoCore(d);
      paint();
      emitState();
      return true;
    }

    // ---- run loop ----

    function sendAudio() {
      const n = M._pce_st_audio_count();
      if (n === 0) return;
      if (audioPort && audioEnabled && !turbo && audioPort.postMessage) {
        const out = new Int16Array(n);
        out.set(new Int16Array(M.HEAPU8.buffer, M._pce_st_audio_buf(), n));
        audioPort.postMessage(out, [out.buffer]);
      }
      M._pce_st_audio_clear();
    }

    function tick() {
      timer = 0;
      if (!running || !M) return;
      const now = performance.now();
      let dt = now - lastTick;
      lastTick = now;
      if (dt > MAX_CATCHUP_MS) dt = MAX_CATCHUP_MS;

      const startClock = M._pce_st_clock_count();
      let framesRun = 0;
      if (turbo) {
        while (performance.now() - now < TURBO_WORK_MS) {
          if (M._pce_st_step_frame() !== 0) break;
          framesRun++;
        }
      } else {
        budgetMs += dt;
        while (budgetMs > 0) {
          const before = M._pce_st_clock_count();
          if (M._pce_st_step_frame() !== 0) break;
          budgetMs -= (M._pce_st_clock_count() - before) / (ST_CPU_CLOCK / 1000);
          framesRun++;
          if (performance.now() - now > MAX_WORK_MS) { budgetMs = 0; break; }
        }
        if (budgetMs > 2 * MAX_CATCHUP_MS) budgetMs = 0;
      }

      reportActivity();
      drawIfNew();
      sendAudio();

      stats.frames += framesRun;
      stats.emulatedMs += (M._pce_st_clock_count() - startClock) / (ST_CPU_CLOCK / 1000);
      const elapsed = now - stats.windowStart;
      if (elapsed >= STATS_INTERVAL_MS) {
        lastStats = {
          fps: stats.frames * 1000 / elapsed,
          speed: stats.emulatedMs / elapsed,
          clock: M._pce_st_clock_count(),
        };
        emit({ type: "stats", stats: lastStats });
        // Tell the page about unsaved floppy changes, every tick while there are any (a write
        // right after a save must not be missed) and when they stop.
        const modifiedNow = floppies.map(function (f, d) { return !!f && !!M._pce_st_disk_modified(d); }).join();
        if (modifiedNow !== lastModified || modifiedNow.indexOf("true") >= 0) { lastModified = modifiedNow; emitState(); }
        stats = { windowStart: now, frames: 0, emulatedMs: 0 };
      }
      schedule();
    }

    function schedule() {
      if (!timer && running) timer = setTimeout(tick, 1);
    }

    function setRunning(value) {
      const next = !!value && !!M;
      if (next === running) return;
      running = next;
      if (running) {
        lastTick = performance.now();
        stats = { windowStart: lastTick, frames: 0, emulatedMs: 0 };
        budgetMs = 0;
        schedule();
      }
      emitState();
    }

    function keyCode(name) {
      if (!(name in keyCache)) {
        keyCache[name] = withStr(M, name, function (p) { return M._pce_st_key_from_name(p); });
      }
      return keyCache[name];
    }

    function requireCore() {
      if (!M) throw new Error("The machine is not ready (is a ROM loaded?)");
      return M;
    }

    // ---- public API ----

    const app = {
      isReady: function () { return !!M; },
      isRunning: function () { return running; },
      hasRom: function () { return !!rom; },
      getState: snapshotState,
      getCounters: function () {
        return {
          ready: !!M,
          frames: M ? M._pce_st_frame_count() : 0,
          clock: M ? M._pce_st_clock_count() : 0,
          stats: lastStats,
          audioDropped: M ? M._pce_st_audio_dropped() : 0,
        };
      },

      start: function () { requireCore(); setRunning(true); return true; },
      pause: function () { setRunning(false); return true; },

      // Hardware reset: CPU and devices restart, RAM is kept (like the ST's reset button).
      reset: function () { requireCore()._pce_st_reset(); lastDrawnFrame = -1; paint(); return true; },

      // Power cycle: a brand-new machine (RAM cleared). Floppies stay in their drives.
      powerCycle: async function () {
        const wasRunning = running;
        setRunning(false);
        await bootCore();
        if (wasRunning && M) setRunning(true);
        return !!M;
      },

      // New hardware configuration ({ mono, ramKB, model }); it restarts the machine.
      configure: async function (next) {
        config = Object.assign({}, config, next || {});
        return app.powerCycle();
      },
      getConfig: function () { return Object.assign({}, config); },

      // ROM image. It takes effect at the next power cycle (or immediately if
      // there is no machine yet).
      loadRom: async function (bytes) {
        rom = toBytes(bytes);
        if (!M) await app.powerCycle();
        else emitState();
        return !!rom;
      },

      setTurbo: function (value) { turbo = !!value; budgetMs = 0; lastPaintAt = 0; emitState(); },
      getTurbo: function () { return turbo; },
      setAudioEnabled: function (value) { audioEnabled = !!value; emitState(); },
      getAudioEnabled: function () { return audioEnabled; },
      setCrtEnabled: function (value) {
        crtEnabled = !!value;
        if (renderer) renderer.setCrtEnabled(crtEnabled);
        paint();
        emitState();
      },
      getCrtEnabled: function () { return crtEnabled; },
      setRenderSize: function (w, h) {
        if (!canvas) return;
        canvas.width = Math.max(1, w | 0);
        canvas.height = Math.max(1, h | 0);
        paint();
      },
      setAudioPort: function (port) { audioPort = port; },

      // ---- input ----

      // code: KeyboardEvent.code; codes with no ST key are ignored.
      onKeyDown: function (code) { sendKey(code, true); },
      onKeyUp: function (code) { sendKey(code, false); },
      releaseAllKeys: function () { /* the proxy tracks pressed keys and releases them */ },
      // Relative mouse motion; buttons: bit 0 left, bit 1 right, bit 2 middle.
      mouse: function (dx, dy, buttons) { if (M) M._pce_st_mouse(dx | 0, dy | 0, buttons | 0); },

      // ---- joystick (port 1) ----

      // PCE emulates the joystick with the numeric keypad; this switches that mode
      // on (the keypad keys then belong to the joystick) or off.
      setJoystickEnabled: function (value) {
        joystickEnabled = !!value;
        app.joystick({});
        if (M) M._pce_st_set_keypad_joystick(joystickEnabled ? 1 : 0);
        emitState();
      },
      getJoystickEnabled: function () { return joystickEnabled; },
      // Sets the stick and fire button: { up, down, left, right, fire } (missing = released).
      // Only the changes are sent to the machine.
      joystick: function (pad) {
        const wanted = {
          Numpad8: !!(pad && pad.up), Numpad2: !!(pad && pad.down),
          Numpad4: !!(pad && pad.left), Numpad6: !!(pad && pad.right), Numpad0: !!(pad && pad.fire),
        };
        Object.keys(wanted).forEach(function (code) {
          if (wanted[code] === !!joystickDown[code]) return;
          if (!joystickEnabled && wanted[code]) return;       // never type digits by accident
          joystickDown[code] = wanted[code];
          sendKey(code, wanted[code]);
        });
      },
      // What the machine sees (IKBD state of port 1) and whether the mode is on.
      getJoystickState: function () {
        return { enabled: joystickEnabled, port1: M ? M._pce_st_joystick_state(1) : 0 };
      },

      // ---- floppy media ----

      mountFloppy: function (drive, bytes, name) {
        const data = toBytes(bytes);
        if (!data || (drive !== 0 && drive !== 1)) return { ok: false, reason: "bad-arguments" };
        const swap = !!floppies[drive];
        floppies[drive] = { name: name || ("disk_" + "AB"[drive] + ".st"), bytes: new Uint8Array(data) };
        const rc = M ? mountIntoCore(drive, swap) : 0;
        emitState();
        return { ok: rc === 0, rc: rc };
      },
      unmountFloppy: function (drive) {
        if (drive !== 0 && drive !== 1) return { ok: false, reason: "bad-arguments" };
        pullFloppy(drive);
        const bytes = floppies[drive] ? floppies[drive].bytes : null;
        if (M) ejectFromCore(drive);
        floppies[drive] = null;
        emitState();
        return { ok: true, bytes: bytes };
      },
      // Saves the guest's changes and returns the current image (a copy), or null.
      flushFloppy: function (drive) {
        if (drive !== 0 && drive !== 1) return null;
        pullFloppy(drive);
        const f = floppies[drive];
        emitState();
        return f ? { name: f.name, bytes: new Uint8Array(f.bytes) } : null;
      },
      hasMountedFloppy: function (drive) { return !!floppies[drive]; },

      // ---- snapshots (full machine state, see implementation/CORE_API.md) ----

      saveSnapshot: function () {
        const core = requireCore();
        for (let d = 0; d < 2; d++) pullFloppy(d);
        return {
          version: 1,
          config: Object.assign({}, config),
          memory: new Uint8Array(core.HEAPU8),
          floppies: floppies.map(function (f) { return f ? { name: f.name, bytes: new Uint8Array(f.bytes) } : null; }),
        };
      },
      loadSnapshot: async function (snap) {
        if (!snap || snap.version !== 1) throw new Error("Unsupported snapshot");
        const wasRunning = running;
        setRunning(false);
        config = Object.assign({}, DEFAULT_CONFIG, snap.config);
        for (let d = 0; d < 2; d++) floppies[d] = snap.floppies[d] ? { name: snap.floppies[d].name, bytes: new Uint8Array(snap.floppies[d].bytes) } : null;
        await bootCore();
        const core = requireCore();
        // The floppy files live in the module's file system, outside the dumped
        // memory; bootCore() has just recreated them.
        if (core.HEAPU8.length !== snap.memory.length) throw new Error("The snapshot does not match this machine's memory layout");
        core.HEAPU8.set(snap.memory);
        lastDrawnFrame = -1;
        paint();
        if (wasRunning) setRunning(true);
        emitState();
        return true;
      },

      // ---- debugging and automation ----

      readMemory: function (addr, length) {
        const core = requireCore();
        const out = new Uint8Array(length | 0);
        for (let i = 0; i < out.length; i++) out[i] = core._pce_st_peek8((addr + i) >>> 0);
        return out;
      },
      writeMemory: function (addr, bytes) {
        const core = requireCore();
        const data = toBytes(bytes);
        if (!data) throw new Error("writeMemory needs a Uint8Array, an ArrayBuffer or an array of bytes");
        for (let i = 0; i < data.length; i++) core._pce_st_poke8((addr + i) >>> 0, data[i]);
        return data.length;
      },
      getRegisters: function () {
        const core = requireCore();
        const names = ["pc", "sr", "sp", "usp"];
        for (let i = 0; i < 8; i++) names.push("d" + i, "a" + i);
        const out = {};
        names.forEach(function (n) { out[n] = withStr(core, n, function (p) { return core._pce_st_reg(p); }); });
        return out;
      },
      // Advances n frames while paused (deterministic stepping for automation).
      stepFrames: function (n) {
        const core = requireCore();
        if (running) throw new Error("Pause the machine before stepping frames");
        for (let i = 0; i < (n | 0); i++) {
          if (core._pce_st_step_frame() !== 0) return false;
          core._pce_st_audio_clear();
        }
        reportActivity();
        drawIfNew();
        return true;
      },
      getStateHash: function () { return M ? M.UTF8ToString(M._pce_st_state_hash()) : null; },
      captureScreenshot: function () {
        const core = requireCore();
        const w = core._pce_st_video_width();
        const h = core._pce_st_video_height();
        const p = core._pce_st_video_buf();
        return { width: w, height: h, rgb: core.HEAPU8.slice(p, p + w * h * 3) };
      },

      dispose: function () {
        disposed = true;
        running = false;
        if (timer) clearTimeout(timer);
        disposeCore();
        if (renderer) renderer.dispose();
        renderer = null;
      },
    };

    function sendKey(code, down) {
      if (!M) return;
      const name = root.PCE_STKeymap.pceKeyName(code);
      if (!name) return;
      const k = keyCode(name);
      if (k) M._pce_st_key(down ? 1 : 2, k);
    }

    await createRenderer();
    await bootCore();
    return app;
  }

  root.PCE_STApp = { create: create };
})(typeof self !== "undefined" ? self : this);
