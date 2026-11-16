// PCE_STAppProxy: the main-thread side of the machine. It creates the emulation
// worker, owns the AudioContext, mirrors the machine's state so the UI can read
// it synchronously, and turns method calls into messages (fire-and-forget for
// input and toggles, request/response with timeouts for everything else).
//
// The method names follow the PCE_STApp API (js/core/st_app.js).
(function (root) {
  "use strict";

  const SAMPLE_RATE = 48000;
  const DEFAULT_TIMEOUT_MS = 10000;
  const TIMEOUTS_MS = {
    powerCycle: 20000, configure: 20000, loadRom: 20000,
    saveSnapshot: 30000, loadSnapshot: 30000, stepFrames: 60000,
  };
  const ASYNC_METHODS = [
    "pause", "reset", "powerCycle", "configure", "unmountFloppy", "flushFloppy",
    "saveSnapshot", "loadSnapshot", "readMemory", "writeMemory", "getRegisters", "stepFrames",
    "getStateHash", "captureScreenshot", "getCounters", "getJoystickState",
  ];

  function create(opts) {
    const options = opts || {};
    const canvas = options.canvas;
    const listeners = { state: [], stats: [], log: [], error: [], activity: [] };
    const pending = new Map();
    const pressedKeys = new Set();
    let nextId = 1;
    let state = {
      ready: false, running: false, turbo: !!options.turbo, audioEnabled: options.audioEnabled !== false,
      crtEnabled: options.crtEnabled !== false, romLoaded: false, config: Object.assign({}, options.config),
      video: { width: 0, height: 0 }, backend: "none", floppies: [null, null],
    };
    let lastStats = null;
    let audioContext = null;
    let audioNode = null;
    let audioStats = { queued: 0, underruns: 0, dropped: 0, peak: 0 };
    let audioSetup = null;
    let disposed = false;

    const worker = new Worker("emulator_worker.js");
    let resolveReady;
    let rejectReady;
    const ready = new Promise(function (resolve, reject) { resolveReady = resolve; rejectReady = reject; });

    function emit(kind, payload) {
      listeners[kind].forEach(function (fn) {
        try { fn(payload); } catch (err) { console.error(err); }
      });
    }

    function applyEvent(event) {
      if (event.type === "state") { state = event.state; emit("state", state); }
      else if (event.type === "stats") { lastStats = event.stats; emit("stats", lastStats); }
      else if (event.type === "activity") emit("activity", event.activity);
      else if (event.type === "log") emit("log", event.text);
    }

    worker.onmessage = function (ev) {
      const m = ev.data;
      if (m.type === "event") applyEvent(m.event);
      else if (m.type === "ready") { state = m.state; resolveReady(state); emit("state", state); }
      else if (m.type === "rpcResult") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
      } else if (m.type === "fatal") {
        emit("error", m.message);
        rejectReady(new Error(m.message));
      }
    };
    worker.onerror = function (e) {
      const message = e.message || "Emulation worker error";
      emit("error", message);
      rejectReady(new Error(message));
    };

    function cmd(method, args, transfer) {
      if (disposed) return;
      worker.postMessage({ type: "cmd", method: method, args: args || [] }, transfer || []);
    }

    function rpc(method, args, transfer) {
      if (disposed) return Promise.reject(new Error("The machine was disposed"));
      return new Promise(function (resolve, reject) {
        const id = nextId++;
        const timeoutMs = TIMEOUTS_MS[method] || DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error("Timed out waiting for " + method + " (" + timeoutMs + " ms)"));
        }, timeoutMs);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        worker.postMessage({ type: "rpc", id: id, method: method, args: args || [] }, transfer || []);
      });
    }

    // ---- audio ----

    // Creates the AudioContext and the worklet (once). Browsers only allow audio
    // after a user gesture, so a suspended context is resumed on the first one.
    function ensureAudio() {
      if (audioSetup) return audioSetup;
      audioSetup = (async function () {
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
        await audioContext.audioWorklet.addModule("js/audio/worklet.js");
        audioNode = new AudioWorkletNode(audioContext, "pce-st-audio", { outputChannelCount: [1] });
        audioNode.connect(audioContext.destination);
        audioNode.port.onmessage = function (ev) { audioStats = ev.data; };
        const channel = new MessageChannel();
        audioNode.port.postMessage({ port: channel.port1 }, [channel.port1]);
        worker.postMessage({ type: "audioPort", port: channel.port2 }, [channel.port2]);
        const resume = function () {
          if (audioContext && audioContext.state === "suspended") audioContext.resume();
        };
        resume();
        ["pointerdown", "keydown", "touchstart"].forEach(function (name) {
          document.addEventListener(name, resume, { passive: true });
        });
      })().catch(function (err) {
        audioSetup = null;
        emit("log", "Audio is unavailable: " + err.message);
      });
      return audioSetup;
    }

    // ---- the API ----

    const proxy = {
      ready: ready,
      onStateChange: function (fn) { listeners.state.push(fn); return function () { listeners.state = listeners.state.filter(function (f) { return f !== fn; }); }; },
      onStats: function (fn) { listeners.stats.push(fn); },
      onDiskActivity: function (fn) { listeners.activity.push(fn); },
      onLog: function (fn) { listeners.log.push(fn); },
      onError: function (fn) { listeners.error.push(fn); },

      // Synchronous state mirror.
      getState: function () { return state; },
      isReady: function () { return !!state.ready; },
      isRunning: function () { return !!state.running; },
      hasRom: function () { return !!state.romLoaded; },
      getTurbo: function () { return !!state.turbo; },
      getAudioEnabled: function () { return !!state.audioEnabled; },
      getCrtEnabled: function () { return !!state.crtEnabled; },
      getConfig: function () { return Object.assign({}, state.config); },
      getVideoSize: function () { return Object.assign({}, state.video); },
      getRendererBackend: function () { return state.backend; },
      hasMountedFloppy: function (drive) { return !!state.floppies[drive]; },
      getFloppyInfo: function (drive) { return state.floppies[drive]; },
      getStats: function () { return lastStats; },
      getAudioStatus: function () {
        return Object.assign({ contextState: audioContext ? audioContext.state : "none" }, audioStats);
      },

      // Lifecycle.
      start: async function () {
        await ensureAudio();
        return rpc("start");
      },
      setTurbo: function (value) { state = Object.assign({}, state, { turbo: !!value }); cmd("setTurbo", [!!value]); },
      setAudioEnabled: function (value) { state = Object.assign({}, state, { audioEnabled: !!value }); cmd("setAudioEnabled", [!!value]); },
      setJoystickEnabled: function (value) { state = Object.assign({}, state, { joystick: !!value }); cmd("setJoystickEnabled", [!!value]); },
      getJoystickEnabled: function () { return !!state.joystick; },
      joystick: function (pad) { cmd("joystick", [pad || {}]); },
      setCrtEnabled: function (value) { state = Object.assign({}, state, { crtEnabled: !!value }); cmd("setCrtEnabled", [!!value]); },
      setRenderSize: function (w, h) { cmd("setRenderSize", [w, h]); },

      // Input. Pressed keys are tracked here so they can all be released at once
      // (window blur, pointer release).
      onKeyDown: function (code) { pressedKeys.add(code); cmd("onKeyDown", [code]); },
      onKeyUp: function (code) { pressedKeys.delete(code); cmd("onKeyUp", [code]); },
      releaseAllKeys: function () {
        pressedKeys.forEach(function (code) { cmd("onKeyUp", [code]); });
        pressedKeys.clear();
      },
      mouse: function (dx, dy, buttons) { cmd("mouse", [dx, dy, buttons]); },

      // Media.
      mountFloppy: function (drive, bytes, name) {
        const copy = new Uint8Array(bytes);        // the caller keeps its own bytes
        return rpc("mountFloppy", [drive, copy, name], [copy.buffer]);
      },
      loadRom: function (bytes) {
        const copy = new Uint8Array(bytes);
        return rpc("loadRom", [copy], [copy.buffer]);
      },
      loadSnapshot: function (snap) {
        return rpc("loadSnapshot", [snap], [snap.memory.buffer]);
      },

      dispose: function () {
        if (disposed) return;
        disposed = true;
        pending.forEach(function (p) { clearTimeout(p.timer); p.reject(new Error("The machine was disposed")); });
        pending.clear();
        worker.terminate();
        if (audioContext) audioContext.close();
      },
    };

    ASYNC_METHODS.forEach(function (name) {
      if (!proxy[name]) proxy[name] = function () { return rpc(name, Array.prototype.slice.call(arguments)); };
    });

    // Starts the worker: the canvas is handed over for good.
    const offscreen = canvas.transferControlToOffscreen();
    const rom = options.rom ? new Uint8Array(options.rom).slice() : null;
    worker.postMessage({
      type: "init", canvas: offscreen, rom: rom, config: options.config,
      crtEnabled: options.crtEnabled, audioEnabled: options.audioEnabled, turbo: options.turbo,
    }, rom ? [offscreen, rom.buffer] : [offscreen]);

    return proxy;
  }

  root.PCE_STAppProxy = { create: create };
})(typeof window !== "undefined" ? window : this);
