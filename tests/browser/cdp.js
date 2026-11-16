"use strict";
// Minimal client for Chrome's DevTools protocol (no dependencies) for tests in
// a real browser: it launches headless Chrome, opens a page and lets you
// evaluate JS, send input and take screenshots.

const { spawn } = require("child_process");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function findChrome() {
  const candidates = [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const { execFileSync } = require("child_process");
  for (const c of candidates) {
    if (!c) continue;
    try { return execFileSync("sh", ["-c", "command -v " + c]).toString().trim(); } catch (e) { /* next one */ }
  }
  throw new Error("Chrome/Chromium not found (set CHROME=/path).");
}

// ---- Minimal WebSocket client ----

function wsConnect(host, port, wsPath) {
  return new Promise(function (resolve, reject) {
    const sock = net.connect(port, host);
    const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const listeners = [];
    let frag = [];

    function handleFrame(opcode, payload) {
      if (opcode === 0x8) { sock.end(); return; }
      if (opcode === 0x9) { send(0xA, payload); return; }
      if (opcode === 0x1 || opcode === 0x0) listeners.forEach(function (fn) { fn(payload.toString("utf8")); });
    }

    function parse() {
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        let opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x0 || (!fin && opcode !== 0x0)) {
          frag.push(payload);
          if (fin) { handleFrame(0x1, Buffer.concat(frag)); frag = []; }
        } else {
          handleFrame(opcode, payload);
        }
      }
    }

    function send(opcode, data) {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }

    sock.on("connect", function () {
      sock.write("GET " + wsPath + " HTTP/1.1\r\nHost: " + host + ":" + port +
        "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
        "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    sock.on("data", function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error("WebSocket rejected: " + head.split("\r\n")[0]));
        upgraded = true;
        buf = buf.subarray(end + 4);
        resolve({
          send: function (text) { send(0x1, text); },
          onMessage: function (fn) { listeners.push(fn); },
          close: function () { sock.destroy(); },
        });
      }
      parse();
    });
    sock.on("error", reject);
  });
}

// ---- Chrome ----

async function launch(options) {
  const opts = options || {};
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-st-chrome-"));
  const args = [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0", "--user-data-dir=" + userDir,
    "--window-size=" + (opts.width || 1000) + "," + (opts.height || 900),
    "about:blank",
  ];
  // Own process group: Chrome spawns helper processes, and closing must kill them all.
  const proc = spawn(findChrome(), args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  const wsUrl = await new Promise(function (resolve, reject) {
    let text = "";
    const timer = setTimeout(function () { reject(new Error("Chrome did not open the debugging port")); }, 20000);
    proc.stderr.on("data", function (d) {
      text += d.toString();
      const m = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", function () { reject(new Error("Chrome exited early")); });
  });
  const u = new URL(wsUrl);
  const ws = await wsConnect(u.hostname, Number(u.port), u.pathname);

  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.onMessage(function (text) {
    const msg = JSON.parse(text);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  // If Chrome goes away, every call still waiting for an answer fails instead of hanging.
  let chromeGone = false;
  function failPending(reason) {
    chromeGone = true;
    pending.forEach(function (p) { p.reject(new Error(reason)); });
    pending.clear();
  }
  proc.on("exit", function () { failPending("Chrome exited"); });

  function call(method, params, sessionId) {
    if (chromeGone) return Promise.reject(new Error("Chrome exited"));
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      const m = { id: id, method: method, params: params || {} };
      if (sessionId) m.sessionId = sessionId;
      ws.send(JSON.stringify(m));
    });
  }

  async function openPage(url) {
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId: targetId, flatten: true });
    const sc = function (method, params) { return call(method, params, sessionId); };
    await sc("Page.enable"); await sc("Runtime.enable");
    const consoleLines = [];
    const timer = setInterval(function () {
      while (events.length) {
        const e = events.shift();
        if (e.sessionId !== sessionId) continue;
        if (e.method === "Runtime.consoleAPICalled") consoleLines.push(e.params.type + ": " + e.params.args.map(function (a) { return a.value !== undefined ? a.value : a.description; }).join(" "));
        if (e.method === "Runtime.exceptionThrown") consoleLines.push("EXCEPTION: " + (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text));
      }
    }, 50);
    timer.unref();
    await sc("Page.navigate", { url: url });
    const page = {
      console: consoleLines,
      evaluate: async function (expression) {
        const r = await sc("Runtime.evaluate", { expression: expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error("evaluate: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        return r.result.value;
      },
      waitFor: async function (expression, timeoutMs, label) {
        const t0 = Date.now();
        for (;;) {
          let v;
          try { v = await page.evaluate(expression); } catch (e) { v = false; }
          if (v) return v;
          if (Date.now() - t0 > (timeoutMs || 10000)) throw new Error("timed out waiting for: " + (label || expression));
          await new Promise(function (r) { setTimeout(r, 100); });
        }
      },
      screenshot: async function (file) {
        const r = await sc("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      },
      key: async function (type, code, key, vk) {
        await sc("Input.dispatchKeyEvent", { type: type, code: code, key: key || code, windowsVirtualKeyCode: vk || 0, text: type === "keyDown" && key && key.length === 1 ? key : undefined });
      },
      mouse: async function (type, x, y, button) {
        await sc("Input.dispatchMouseEvent", { type: type, x: x, y: y, button: button || "none", buttons: type === "mouseReleased" ? 0 : 1, clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0 });
      },
      // Touch input: type is touchStart, touchMove or touchEnd; points is [{x, y}].
      touch: async function (type, points) {
        await sc("Input.dispatchTouchEvent", { type: type, touchPoints: (points || []).map(function (p, i) { return { x: p.x, y: p.y, id: i }; }) });
      },
      // Emulates a viewport size (mobile = true enables the touch/mobile mode).
      setViewport: async function (width, height, mobile) {
        await sc("Emulation.setDeviceMetricsOverride", { width: width, height: height, deviceScaleFactor: 1, mobile: !!mobile });
        if (mobile) await sc("Emulation.setTouchEmulationEnabled", { enabled: true });
      },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      // Closes the page. Its localStorage and IndexedDB databases are cleared first:
      // they persist between pages of the same origin and tests must start clean.
      // keepData leaves all of it (for tests that reload the page on purpose).
      close: async function (keepData) {
        if (!keepData) {
          try { await page.evaluate("try { localStorage.clear(); } catch (e) { /* no storage */ } true"); } catch (e) { /* the page may be gone */ }
          // Empties every object store (deleting the databases would block while the
          // page still holds its connections).
          const clear = "Promise.all(['pce_st_disk_library', 'pce_st_rom_library', 'pce_st_snapshots'].map(function (name) {" +
            " return new Promise(function (resolve) {" +
            "  var req = indexedDB.open(name);" +
            "  req.onerror = req.onblocked = function () { resolve(); };" +
            "  req.onupgradeneeded = function () { req.transaction.abort(); };" +
            "  req.onsuccess = function () {" +
            "   var db = req.result, names = Array.from(db.objectStoreNames);" +
            "   if (!names.length) { db.close(); resolve(); return; }" +
            "   var tx = db.transaction(names, 'readwrite');" +
            "   names.forEach(function (n) { tx.objectStore(n).clear(); });" +
            "   tx.oncomplete = tx.onerror = tx.onabort = function () { db.close(); resolve(); };" +
            "  };" +
            " });" +
            "})).then(function () { return true; })";
          try { await page.evaluate(clear); } catch (e) { /* the page may be gone */ }
        }
        clearInterval(timer);
        await call("Target.closeTarget", { targetId: targetId });
      },
    };
    return page;
  }

  return {
    openPage: openPage,
    close: async function () {
      try { ws.close(); } catch (e) { /* already closed */ }
      try { process.kill(-proc.pid, "SIGKILL"); } catch (e) { proc.kill("SIGKILL"); }
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    },
  };
}

module.exports = { launch: launch, wsConnect: wsConnect };
