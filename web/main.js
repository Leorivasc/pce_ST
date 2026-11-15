// Main thread: user interface, input (keyboard, mouse with Pointer Lock) and audio.
// Emulation runs in worker.js; the video is drawn there on an OffscreenCanvas.
(function () {
  "use strict";

  const ROM_URL = "/roms/emutos/etos192us.img";
  const SAMPLE_RATE = 48000;

  const $ = function (id) { return document.getElementById(id); };
  const els = {
    start: $("start"), pause: $("pause"), reset: $("reset"), speed: $("speed"),
    monitor: $("monitor"), mount: $("mount"), save: $("save"),
    screen: $("screen"), status: $("status"), error: $("error"),
  };

  let worker = null;
  let audioCtx = null;
  let audioNode = null;
  let offscreenTransferred = false;
  let romBuffer = null;
  let running = false;
  let lastStats = null;
  let audioStats = { queued: 0, underruns: 0, dropped: 0 };
  let videoSize = { width: 0, height: 0 };
  let mouseSent = 0;
  let pendingFloppy = null;
  const pendingShots = {};
  let shotSeq = 0;
  const pressed = new Set();
  let buttons = 0;

  function showError(text) { els.error.textContent = text || ""; }

  function renderStatus() {
    if (!worker) { els.status.textContent = "Not started."; return; }
    const s = lastStats;
    const parts = [running ? "Running" : "Paused"];
    if (s) {
      parts.push(s.fps.toFixed(1) + " fps");
      parts.push(s.speed.toFixed(2) + "× real time");
    }
    if (videoSize.width) parts.push(videoSize.width + "×" + videoSize.height);
    if (audioCtx) {
      parts.push("audio " + audioCtx.state + ", queue " + audioStats.queued +
        ", underruns " + audioStats.underruns + ", dropped " + audioStats.dropped);
    }
    els.status.textContent = parts.join(" · ");
  }

  async function loadRom() {
    if (romBuffer) return romBuffer;
    const resp = await fetch(ROM_URL);
    if (!resp.ok) throw new Error("Could not load the ROM (" + resp.status + ")");
    romBuffer = await resp.arrayBuffer();
    return romBuffer;
  }

  async function setupAudio() {
    if (audioCtx) return null;
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    await audioCtx.audioWorklet.addModule("audio-worklet.js");
    audioNode = new AudioWorkletNode(audioCtx, "pce-st-audio", { outputChannelCount: [1] });
    audioNode.connect(audioCtx.destination);
    audioNode.port.onmessage = function (ev) { audioStats = ev.data; };
    const channel = new MessageChannel();
    audioNode.port.postMessage({ port: channel.port1 }, [channel.port1]);
    return channel.port2;
  }

  function onWorkerMessage(ev) {
    const m = ev.data;
    switch (m.type) {
      case "stats": lastStats = m; break;
      case "videoSize": videoSize = { width: m.width, height: m.height }; break;
      case "running":
        running = m.running;
        els.pause.textContent = running ? "Pause" : "Resume";
        break;
      case "ready":
        els.pause.disabled = false; els.reset.disabled = false; els.save.disabled = false;
        break;
      case "error": showError(m.message); break;
      case "floppy":
        if (pendingFloppy) { pendingFloppy(m); pendingFloppy = null; } else downloadFloppy(m);
        break;
      case "memory":
        if (pendingShots[m.id]) { pendingShots[m.id](m); delete pendingShots[m.id]; }
        break;
      case "screenshot":
        if (pendingShots[m.id]) { pendingShots[m.id](m); delete pendingShots[m.id]; }
        break;
      case "log": if (window.PCE_ST_DEBUG) window.PCE_ST_DEBUG.log.push(m.text); break;
      default: break;
    }
    renderStatus();
  }

  async function start() {
    showError("");
    els.start.disabled = true;
    try {
      const rom = await loadRom();
      const audioPort = await setupAudio();
      if (!worker) {
        worker = new Worker("worker.js");
        worker.onmessage = onWorkerMessage;
        worker.onerror = function (e) { showError("Worker error: " + e.message); };
      }
      const msg = {
        type: "init", rom: rom.slice(0), mono: els.monitor.value === "mono",
        sampleRate: SAMPLE_RATE, autostart: true,
      };
      const transfer = [msg.rom];
      if (!offscreenTransferred) {
        msg.canvas = els.screen.transferControlToOffscreen();
        offscreenTransferred = true;
        transfer.push(msg.canvas);
      }
      if (audioPort) { msg.audioPort = audioPort; transfer.push(audioPort); }
      worker.postMessage(msg, transfer);
      els.start.textContent = "Restart with this monitor";
      els.start.disabled = false;
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      worker.postMessage({ type: "speed", speed: Number(els.speed.value) });
    } catch (err) {
      showError(String(err && err.message ? err.message : err));
      els.start.disabled = false;
    }
  }

  // ---- input ----

  function inputActive() {
    return document.pointerLockElement === els.screen || document.activeElement === els.screen;
  }

  function releaseAll() {
    if (!worker) return;
    pressed.forEach(function (code) { worker.postMessage({ type: "key", code: code, down: false }); });
    pressed.clear();
    if (buttons) { buttons = 0; worker.postMessage({ type: "mouse", dx: 0, dy: 0, buttons: 0 }); }
  }

  document.addEventListener("keydown", function (e) {
    if (!worker || !inputActive() || e.repeat) return;
    if (!window.PCE_STKeymap.pceKeyName(e.code)) return;
    e.preventDefault();
    pressed.add(e.code);
    worker.postMessage({ type: "key", code: e.code, down: true });
  });
  document.addEventListener("keyup", function (e) {
    if (!worker || !pressed.has(e.code)) return;
    e.preventDefault();
    pressed.delete(e.code);
    worker.postMessage({ type: "key", code: e.code, down: false });
  });
  window.addEventListener("blur", releaseAll);

  els.screen.addEventListener("click", function () {
    els.screen.focus();
    if (worker && document.pointerLockElement !== els.screen) {
      const p = els.screen.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(function () { els.screen.requestPointerLock(); });
    }
  });
  document.addEventListener("pointerlockchange", function () {
    if (document.pointerLockElement !== els.screen) releaseAll();
  });
  document.addEventListener("mousemove", function (e) {
    if (!worker || document.pointerLockElement !== els.screen) return;
    mouseSent++;
    worker.postMessage({ type: "mouse", dx: e.movementX, dy: e.movementY, buttons: buttons });
  });
  function mouseButton(e, down) {
    if (!worker || document.pointerLockElement !== els.screen) return;
    const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
    if (!bit) return;
    buttons = down ? (buttons | bit) : (buttons & ~bit);
    e.preventDefault();
    worker.postMessage({ type: "mouse", dx: 0, dy: 0, buttons: buttons });
  }
  document.addEventListener("mousedown", function (e) { mouseButton(e, true); });
  document.addEventListener("mouseup", function (e) { mouseButton(e, false); });
  els.screen.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  // ---- controls ----

  els.start.addEventListener("click", start);
  els.pause.addEventListener("click", function () {
    if (worker) worker.postMessage({ type: "run", run: !running });
  });
  els.reset.addEventListener("click", function () {
    if (worker) worker.postMessage({ type: "reset" });
  });
  els.speed.addEventListener("change", function () {
    if (worker) worker.postMessage({ type: "speed", speed: Number(els.speed.value) });
  });
  els.monitor.addEventListener("change", function () {
    if (worker) start(); // restarts the machine with the other monitor
  });
  els.mount.addEventListener("change", async function () {
    const file = els.mount.files[0];
    if (!file || !worker) return;
    worker.postMessage({ type: "mount", drive: 0, bytes: await file.arrayBuffer() });
    els.mount.value = "";
  });
  els.save.addEventListener("click", function () {
    if (worker) worker.postMessage({ type: "flush", drive: 0 });
  });

  function downloadFloppy(m) {
    if (!m.bytes) { showError("No floppy is mounted in A:."); return; }
    const url = URL.createObjectURL(new Blob([m.bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url; a.download = "disk_A.st";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.setInterval(renderStatus, 500);

  // For automated tests: state and message sending to the worker.
  window.PCE_ST_DEBUG = {
    log: [],
    state: function () {
      return { running: running, mouseSent: mouseSent, stats: lastStats, audio: audioStats, video: videoSize, audioState: audioCtx && audioCtx.state };
    },
    send: function (msg, transfer) { worker.postMessage(msg, transfer || []); },
    // Current video as {width, height, rgb: Uint8Array}.
    screenshot: function () {
      return new Promise(function (resolve) {
        const id = ++shotSeq;
        pendingShots[id] = function (m) { resolve({ width: m.width, height: m.height, rgb: new Uint8Array(m.rgb) }); };
        worker.postMessage({ type: "screenshot", id: id });
      });
    },
    // Reads `length` bytes from the ST's bus starting at `addr`.
    peek: function (addr, length) {
      return new Promise(function (resolve) {
        const id = ++shotSeq;
        pendingShots[id] = function (m) { resolve(new Uint8Array(m.bytes)); };
        worker.postMessage({ type: "peek", id: id, addr: addr, length: length });
      });
    },
    // Floppy in A: after flushing it, without downloading it.
    readFloppy: function (drive) {
      return new Promise(function (resolve) {
        pendingFloppy = function (m) { resolve({ rc: m.rc, bytes: m.bytes ? new Uint8Array(m.bytes) : null }); };
        worker.postMessage({ type: "flush", drive: drive });
      });
    },
    start: start,
  };

  if (new URLSearchParams(location.search).has("autostart")) start();
})();
