"use strict";
// Tests of web/index.html in a real (headless) Chrome.
//
// Usage:  node tests/browser/browser.test.js [--only=text]
// Requirements: scripts/build-core.sh already run and Chrome/Chromium installed
// (or CHROME=/path/to/browser). It starts its own server on a free port.
//
// The page exposes the machine as window.PCE_ST_APP (the proxy from
// js/core/app_proxy.js). The video is drawn on the worker's OffscreenCanvas and
// cannot be read from the main thread, so tests read it with
// PCE_ST_APP.captureScreenshot().

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { start } = require("../../scripts/serve.js");
const { launch } = require("./cdp.js");
const { makeBlankST, listRoot } = require("../core/stimage.js");

const OUT = path.join(__dirname, "..", "..", "build", "out");
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

let base = "";
let chrome = null;

// In-page helpers: screenshots and comparisons without moving the whole buffer out.
const PAGE_HELPERS = `
  window.__shot = async function () { window.__last = await PCE_ST_APP.captureScreenshot(); return [window.__last.width, window.__last.height]; };
  window.__dark = function (x0, y0, x1, y1) {
    const s = window.__last; let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (s.rgb[(y * s.width + x) * 3] < 128) n++;
    return n;
  };
  window.__mark = function () { window.__ref = window.__last; };
  window.__diff = function (x0, y0, x1, y1) {
    const a = window.__ref, b = window.__last; let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * a.width + x) * 3; if (a.rgb[i] !== b.rgb[i]) n++; }
    return n;
  };
  window.__click = function (id) { document.getElementById(id).click(); return true; };
  window.__select = function (id, value) { var s = document.getElementById(id); s.value = value; s.dispatchEvent(new Event('change')); return true; };
  window.__psg = function (reg, val) { PCE_ST_APP.writeMemory(0xff8800, [reg]); PCE_ST_APP.writeMemory(0xff8802, [val]); };
  true;
`;

// Pages open with the CRT filter off ("?crt=0") unless a test asks for it. Headless
// Chrome renders WebGL in software, where a CRT-filtered frame costs more than
// emulating it; with the filter off the tests are fast and far less sensitive to
// the load of the machine they run on.
async function openPage(query) {
  const page = await chrome.openPage(base + "/web/index.html" + (query === undefined ? "?crt=0" : query));
  await page.waitFor("window.PCE_ST_APP && PCE_ST_APP.isRunning()", 45000, "machine running");
  await page.evaluate(PAGE_HELPERS);
  return page;
}

const DESKTOP_DRAWN = "(async function(){ await __shot(); var bar = __dark(0,0,640,18), bg = __dark(0,100,640,390);" +
  " return bar > 200 && bar < 4000 && bg > 70000 && bg < 120000; })()";

// Waits for the EmuTOS desktop to be drawn (monochrome), using the turbo button.
// The desktop is dotted (~48 % dark pixels), not all black like a freshly
// created video buffer, and has text in the menu bar.
async function reachDesktop(page) {
  await page.evaluate("__click('btnTurbo')");
  await page.waitFor(DESKTOP_DRAWN, 40000, "EmuTOS desktop");
  await page.evaluate("__click('btnTurbo')");
}

async function noPageErrors(page) {
  const bad = page.console.filter(function (l) { return /EXCEPTION|error:/i.test(l); });
  assert.deepStrictEqual(bad, [], "errors in the console");
}

async function lockPointer(page) {
  const box = await page.evaluate("(function(){var r=document.getElementById('screen').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await page.mouse("mouseMoved", box.x, box.y);
  await page.mouse("mousePressed", box.x, box.y, "left");
  await page.mouse("mouseReleased", box.x, box.y, "left");
  await page.waitFor("document.pointerLockElement === document.getElementById('screen')", 5000, "pointer captured");
  return box;
}

function pickFile(inputId, bytes, name) {
  return "(function(){var b=Uint8Array.from(atob('" + Buffer.from(bytes).toString("base64") + "'),function(c){return c.charCodeAt(0);});" +
    "var dt=new DataTransfer();dt.items.add(new File([b],'" + name + "'));var i=document.getElementById('" + inputId + "');i.files=dt.files;i.dispatchEvent(new Event('change'));return true;})()";
}


// Center of an element in page coordinates, to click it with real mouse events.
async function centerOf(page, selector) {
  return page.evaluate("(function(){var e=document.querySelector(" + JSON.stringify(selector) + ");e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
}

async function clickAt(page, p) {
  await page.mouse("mouseMoved", p.x, p.y);
  await page.mouse("mousePressed", p.x, p.y, "left");
  await page.mouse("mouseReleased", p.x, p.y, "left");
}

// Records every key event the page sends to the machine, in window.__keys.
const RECORD_KEYS = `
  window.__keys = [];
  (function () {
    const down = PCE_ST_APP.onKeyDown, up = PCE_ST_APP.onKeyUp;
    PCE_ST_APP.onKeyDown = function (c) { window.__keys.push('down:' + c); return down.call(PCE_ST_APP, c); };
    PCE_ST_APP.onKeyUp = function (c) { window.__keys.push('up:' + c); return up.call(PCE_ST_APP, c); };
  })();
  true;
`;

test("starts by itself and runs in real time (~71 fps, 1.0x) with audio active", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_APP.getStats()", 15000, "statistics");
  await page.sleep(3500);
  const st = await page.evaluate("({ state: PCE_ST_APP.getState(), stats: PCE_ST_APP.getStats(), audio: PCE_ST_APP.getAudioStatus() })");
  assert.strictEqual(st.state.running, true);
  assert.strictEqual(st.state.backend, "webgl2");
  assert.strictEqual(st.state.video.width, 640);
  assert.strictEqual(st.state.video.height, 400);
  assert.ok(st.stats.speed > 0.9 && st.stats.speed < 1.1, "speed " + st.stats.speed);
  assert.ok(st.stats.fps > 60 && st.stats.fps < 80, "fps " + st.stats.fps);
  assert.strictEqual(st.audio.contextState, "running");
  assert.ok(st.audio.underruns <= 8, "audio underruns " + st.audio.underruns);   // allows for a loaded machine
  await noPageErrors(page);
  await page.close();
});

test("the interface is in English and reflects the machine state", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_APP.getStats()", 15000);
  const ui = await page.evaluate(`({
    title: document.title,
    lang: document.documentElement.lang,
    startTitle: document.getElementById('btnStart').title,
    romName: document.getElementById('romName').textContent,
    romLoaded: document.getElementById('romStatus').classList.contains('loaded'),
    status: document.getElementById('statusLine').textContent,
    theme: document.documentElement.dataset.uiTheme,
    resetDisabled: document.getElementById('btnReset').disabled,
  })`);
  assert.strictEqual(ui.title, "PCE_ST");
  assert.strictEqual(ui.lang, "en");
  assert.ok(/^Pause emulation/.test(ui.startTitle), "start button title: " + ui.startTitle);
  assert.strictEqual(ui.romName, "EmuTOS");
  assert.strictEqual(ui.romLoaded, true);
  assert.ok(/fps/.test(ui.status) && /640x400/.test(ui.status), "status line: " + ui.status);
  assert.strictEqual(ui.theme, "st");
  assert.strictEqual(ui.resetDisabled, false);
  const text = await page.evaluate("document.body.innerText");
  assert.ok(!/\b(Iniciar|Pausa|Reiniciar|Velocidad|Guardar|Montar)\b/.test(text), "unexpected non-English text");
  await page.close();
});

test("the pause button stops the clock and resuming restarts it", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_APP.getStats()", 15000);
  await page.evaluate("__click('btnStart')");
  await page.waitFor("PCE_ST_APP.isRunning() === false", 5000, "paused");
  await page.sleep(800);
  const c1 = await page.evaluate("PCE_ST_APP.getCounters().then(function(c){return c.clock;})");
  await page.sleep(800);
  const c2 = await page.evaluate("PCE_ST_APP.getCounters().then(function(c){return c.clock;})");
  assert.strictEqual(c1, c2, "the clock does not advance while paused");
  await page.evaluate("__click('btnStart')");
  await page.waitFor("PCE_ST_APP.isRunning() === true", 5000, "resumes");
  await page.sleep(800);
  const c3 = await page.evaluate("PCE_ST_APP.getCounters().then(function(c){return c.clock;})");
  assert.ok(c3 > c2, "the clock advances after resuming");
  await page.close();
});

test("turbo speeds up emulation, reaches the desktop and goes back to real time", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnTurbo')");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getTurbo()"), true);
  await page.sleep(1500);
  const turbo = await page.evaluate("PCE_ST_APP.getStats().speed");
  assert.ok(turbo > 2, "turbo speed " + turbo);
  await page.waitFor(DESKTOP_DRAWN, 40000, "EmuTOS desktop");
  await page.evaluate("__click('btnTurbo')");
  await page.sleep(2500);
  const back = await page.evaluate("PCE_ST_APP.getStats().speed");
  assert.ok(back > 0.9 && back < 1.1, "back to real time: " + back);
  await page.close();
});

test("the real keyboard (Chrome events) reaches TOS: the A key leaves its code in RAM", async function () {
  const page = await openPage();
  await reachDesktop(page);
  await page.evaluate("document.getElementById('screen').focus(); PCE_ST_APP.readMemory(0, 0x20000).then(function(b){ window.__before = b; }); true");
  await page.waitFor("window.__before", 5000, "RAM before");
  // ~80 ms pauses (several frames) between events, like a person.
  await page.key("rawKeyDown", "KeyA", "a", 65); await page.sleep(80);
  await page.key("keyUp", "KeyA", "a", 65); await page.sleep(200);
  await page.evaluate("PCE_ST_APP.readMemory(0, 0x20000).then(function(b){ window.__ram = b; }); true");
  await page.waitFor("window.__ram", 5000, "RAM after");
  const found = await page.evaluate("(function(){var a=window.__before,b=window.__ram;for(var i=0;i<a.length;i++)if(a[i]!==b[i]&&b[i]===0x1e)return true;return false;})()");
  assert.ok(found, "scancode 0x1E appears in RAM after pressing A");
  await page.close();
});

test("audio reaches the worklet: silence at rest, a tone with signal, and back to silence", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_APP.getStats()", 15000);
  await page.waitFor("PCE_ST_APP.getAudioStatus().peak === 0", 6000, "silence at startup (no clicks)");
  await page.evaluate("__psg(0, 0xc0); __psg(1, 0x01); __psg(7, 0x3e); __psg(8, 0x0f); true");
  await page.waitFor("PCE_ST_APP.getAudioStatus().peak > 0.1", 6000, "the worklet plays the tone");
  assert.ok(await page.evaluate("PCE_ST_APP.getAudioStatus().peak < 0.6"), "does not clip");
  await page.evaluate("__psg(8, 0); true");
  await page.waitFor("PCE_ST_APP.getAudioStatus().peak === 0", 8000, "back to silence");
  await page.close();
});

test("the audio button mutes the output without stopping the machine", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_APP.getStats()", 15000);
  await page.evaluate("__click('btnAudio')");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getAudioEnabled()"), false);
  await page.evaluate("__psg(0, 0xc0); __psg(1, 0x01); __psg(7, 0x3e); __psg(8, 0x0f); true");
  // The PSG really plays the tone (its registers are set): the proof is that it
  // reaches the worklet as soon as the audio is switched back on.
  await page.sleep(1500);
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getAudioStatus().peak"), 0, "muted: nothing reaches the worklet");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.isRunning()"), true);
  await page.evaluate("__click('btnAudio')");
  await page.waitFor("PCE_ST_APP.getAudioStatus().peak > 0.1", 6000, "the tone is heard once audio is back on");
  await page.close();
});

test("the CRT filter renders with WebGL2; its button switches it and remembers the choice", async function () {
  const page = await openPage("?crt=1");
  await page.waitFor("PCE_ST_APP.getStats()", 30000, "statistics");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getCrtEnabled()"), true);
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getRendererBackend()"), "webgl2");
  assert.ok(await page.evaluate("PCE_ST_APP.getStats().fps") > 30, "the filtered video keeps a usable frame rate");
  await page.evaluate("__click('btnCrt')");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getCrtEnabled()"), false);
  assert.strictEqual(await page.evaluate("localStorage.getItem('pce_st_crt_enabled')"), "false");
  assert.strictEqual(await page.evaluate("document.getElementById('screen').classList.contains('crtDisabled')"), true);
  await page.evaluate("__click('btnCrt')");
  assert.strictEqual(await page.evaluate("localStorage.getItem('pce_st_crt_enabled')"), "true");
  await page.close();
});

test("the monitor and memory selectors restart the machine with the new hardware", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnControlsCollapse')");
  await page.evaluate("__select('monitorSelect', 'color')");
  await page.waitFor("PCE_ST_APP.getState().video.width === 320 && PCE_ST_APP.getState().video.height === 200", 15000, "320x200");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getConfig().mono"), false);
  assert.strictEqual(await page.evaluate("localStorage.getItem('pce_st_monitor')"), "color");
  await page.evaluate("__select('ramSelect', '2048')");
  await page.waitFor("PCE_ST_APP.getConfig().ramKB === 2048", 15000, "2 MB configured");
  // TOS records the top of physical memory (phystop, at 0x42E): wait until it has run.
  await page.waitFor("PCE_ST_APP.readMemory(0x42e, 4).then(function(b){return ((b[0]<<24)|(b[1]<<16)|(b[2]<<8)|b[3])>>>0 === 0x200000;})", 20000, "phystop = 2 MB");
  await noPageErrors(page);
  await page.close();
});

test("a floppy chosen with the file selector is mounted, and Save A: returns the image", async function () {
  const page = await openPage();
  const img = makeBlankST("WEBTEST", [{ name: "HELLO.TXT", data: "hello from the browser" }]);
  assert.strictEqual(await page.evaluate("document.getElementById('btnSaveFloppy').disabled"), true);
  await page.evaluate(pickFile("disk1", img, "web_test.st"));
  await page.waitFor("PCE_ST_APP.hasMountedFloppy(0)", 5000, "floppy mounted");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getFloppyInfo(0).name"), "web_test.st");
  assert.strictEqual(await page.evaluate("document.getElementById('btnSaveFloppy').disabled"), false);
  const r = await page.evaluate("PCE_ST_APP.flushFloppy(0).then(function(f){return {n:f.bytes.length,sum:f.bytes.reduce(function(a,b){return (a*31+b)>>>0;},0)};})");
  assert.strictEqual(r.n, img.length);
  let sum = 0;
  for (let i = 0; i < img.length; i++) sum = (sum * 31 + img[i]) >>> 0;
  assert.strictEqual(r.sum, sum, "the floppy comes back identical");
  assert.deepStrictEqual(listRoot(img).map(function (e) { return e.name; }), ["HELLO.TXT"]);
  await page.close();
});

test("the disk library mounts floppies and programs through the proxy and persists them", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_LIBRARY.isReady()", 10000, "library ready");
  const tag = "T" + Date.now().toString(36).toUpperCase().slice(-7);  // fits 8.3
  const img = makeBlankST("LIBTEST", [{ name: "HELLO.TXT", data: "from the library" }]);
  const b64 = function (bytes) { return Buffer.from(bytes).toString("base64"); };
  const decode = "function(t){return Uint8Array.from(atob(t),function(c){return c.charCodeAt(0);});}";
  const added = await page.evaluate("(async function(){var d=" + decode + ";" +
    "var f=await PCE_ST_LIBRARY.addFile('" + tag + ".ST', d('" + b64(img) + "'));" +
    "var p=await PCE_ST_LIBRARY.addFile('" + tag + ".PRG', d('" + b64(Buffer.from([0x60, 0x1a, 0, 0])) + "'));" +
    "await PCE_ST_LIBRARY.mountFile(f.id, 0); await PCE_ST_LIBRARY.mountFile(p.id, 1);" +
    "return {f:f.id,p:p.id};})()");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.hasMountedFloppy(0) && PCE_ST_APP.hasMountedFloppy(1)"), true);
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getFloppyInfo(0).name"), tag + ".ST");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getFloppyInfo(1).name"), tag + ".ST".replace(".ST", ".ST"), "the program is mounted as a generated floppy");
  const wrapped = await page.evaluate("PCE_ST_APP.flushFloppy(1).then(function(f){return PCE_STImage.verify(f.bytes);})");
  assert.strictEqual(wrapped.valid, true);
  assert.deepStrictEqual(wrapped.files.map(function (f) { return f.path; }), [tag + ".PRG"]);
  const back = await page.evaluate("PCE_ST_APP.flushFloppy(0).then(function(f){return f.bytes.length;})");
  assert.strictEqual(back, img.length);
  assert.strictEqual(await page.evaluate("PCE_ST_LIBRARY.listFiles().filter(function(f){return f.mountedSlot>=0&&f.name.indexOf('" + tag + "')===0;}).length"), 2);
  // Persistence: a new page sees the entries (IndexedDB).
  await page.evaluate("PCE_ST_LIBRARY.unmountFile('" + added.f + "')");
  await page.sleep(500);
  await page.close(true);
  const again = await openPage();
  await again.waitFor("PCE_ST_LIBRARY.isReady()", 10000, "library ready again");
  assert.strictEqual(await again.evaluate("PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name.indexOf('" + tag + "')===0;}).length"), 2);
  await again.evaluate("PCE_ST_LIBRARY.deleteFile('" + added.f + "').then(function(){return PCE_ST_LIBRARY.deleteFile('" + added.p + "');})");
  await again.close();
});

test("a ROM chosen with the file selector restarts the machine; a wrong size is rejected", async function () {
  const page = await openPage();
  const rom = fs.readFileSync(path.join(__dirname, "..", "..", "roms", "emutos", "etos192us.img"));
  await page.evaluate(pickFile("romInput", Buffer.alloc(1000), "tiny.img"));
  await page.sleep(500);
  assert.strictEqual(await page.evaluate("document.getElementById('romName').textContent"), "EmuTOS", "the label is unchanged");
  await page.evaluate(pickFile("romInput", rom, "my_tos.img"));
  await page.waitFor("document.getElementById('romName').textContent === 'my_tos'", 15000, "ROM label");
  await page.waitFor("PCE_ST_APP.isRunning() && PCE_ST_APP.getStats()", 15000, "running again");
  await page.close();
});

test("the theme selector applies and remembers the theme", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnControlsCollapse')");
  await page.evaluate("__select('uiThemeSelect', 'classic')");
  assert.strictEqual(await page.evaluate("document.documentElement.dataset.uiTheme"), "classic");
  assert.strictEqual(await page.evaluate("localStorage.getItem('pce_st_ui_theme')"), "classic");
  await page.close();
});

test("a snapshot restores the exact machine state", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_APP.getStats()", 15000);
  await page.evaluate("__click('btnStart')");
  await page.waitFor("PCE_ST_APP.isRunning() === false", 5000, "paused");
  const hashA = await page.evaluate("PCE_ST_APP.getStateHash()");
  await page.evaluate("PCE_ST_APP.saveSnapshot().then(function(s){ window.__snap = s; return true; })");
  await page.evaluate("PCE_ST_APP.stepFrames(30)");
  const hashB = await page.evaluate("PCE_ST_APP.getStateHash()");
  assert.notStrictEqual(hashA, hashB, "stepping changes the state");
  await page.evaluate("PCE_ST_APP.loadSnapshot(window.__snap).then(function(){ return true; })");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getStateHash()"), hashA, "the restored state matches");
  await page.evaluate("PCE_ST_APP.stepFrames(30)");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getStateHash()"), hashB, "it continues identically");
  await page.close();
});

test("clicking the screen captures the mouse (Pointer Lock) and the mouse button toggles it", async function () {
  const page = await openPage();
  await reachDesktop(page);
  await lockPointer(page);
  // The button follows the pointerlockchange event, which fires a moment after the lock is set.
  await page.waitFor("document.getElementById('btnMouse').classList.contains('active')", 5000, "mouse button active");
  await page.evaluate("__click('btnMouse')");
  await page.waitFor("document.pointerLockElement === null", 5000, "pointer released");
  await page.waitFor("!document.getElementById('btnMouse').classList.contains('active')", 5000, "mouse button inactive");
  await page.close();
});

test("with the pointer captured, moving the mouse reaches the TOS cursor", async function () {
  const page = await openPage();
  await reachDesktop(page);
  const box = await lockPointer(page);
  await page.sleep(300);
  await page.evaluate("__shot()"); await page.evaluate("__mark()");
  for (let i = 1; i <= 12; i++) { await page.mouse("mouseMoved", box.x + i * 8, box.y + i * 4); await page.sleep(30); }
  await page.sleep(400);
  await page.evaluate("__shot()");
  const moved = await page.evaluate("__diff(0,0,640,400)");
  assert.ok(moved > 20, "the TOS cursor moved (" + moved + " different pixels)");
  await page.close();
});

test("the on-screen keyboard shows and hides, and every key maps to an ST key", async function () {
  const page = await openPage();
  assert.strictEqual(await page.evaluate("document.getElementById('keyboardPanel').hidden"), true, "hidden at first");
  await page.evaluate("__click('btnKeyboard')");
  assert.strictEqual(await page.evaluate("document.getElementById('keyboardPanel').hidden"), false);
  assert.strictEqual(await page.evaluate("document.getElementById('btnKeyboard').classList.contains('active')"), true);
  const info = await page.evaluate(`(function () {
    var keys = Array.from(document.querySelectorAll('#stKeyboard button.stKey'));
    return {
      total: keys.length,
      disabled: keys.filter(function (k) { return k.disabled; }).length,
      unmapped: keys.filter(function (k) { return k.dataset.code && !PCE_STKeymap.pceKeyName(k.dataset.code); }).map(function (k) { return k.dataset.code; }),
      has: ['F1','F10','Escape','Enter','Space','ShiftLeft','ShiftRight','ControlLeft','AltLeft','CapsLock','Delete','Backspace','End','PageDown','Insert','Home','ArrowUp','Numpad0','NumpadEnter'].filter(function (c) { return !document.querySelector('#stKeyboard [data-code="' + c + '"]'); }),
    };
  })()`);
  assert.ok(info.total >= 90, "keys on the keyboard: " + info.total);
  assert.deepStrictEqual(info.unmapped, [], "keys with no mapping to an ST key");
  assert.deepStrictEqual(info.has, [], "expected keys are missing");
  assert.strictEqual(info.disabled, 2, "( and ) are drawn but disabled");
  await page.evaluate("__click('btnKeyboard')");
  assert.strictEqual(await page.evaluate("document.getElementById('keyboardPanel').hidden"), true);
  await page.close();
});

test("clicking an on-screen key reaches TOS (A leaves its scancode in RAM)", async function () {
  const page = await openPage();
  await reachDesktop(page);
  await page.evaluate("__click('btnKeyboard')");
  await page.evaluate("PCE_ST_APP.readMemory(0, 0x20000).then(function(b){ window.__before = b; }); true");
  await page.waitFor("window.__before", 5000, "RAM before");
  const a = await centerOf(page, '#stKeyboard [data-code="KeyA"]');
  await page.mouse("mouseMoved", a.x, a.y);
  await page.mouse("mousePressed", a.x, a.y, "left"); await page.sleep(120);
  assert.strictEqual(await page.evaluate("document.querySelector('#stKeyboard [data-code=\"KeyA\"]').classList.contains('pressed')"), true, "the key looks pressed");
  await page.mouse("mouseReleased", a.x, a.y, "left"); await page.sleep(250);
  assert.strictEqual(await page.evaluate("document.querySelector('#stKeyboard [data-code=\"KeyA\"]').classList.contains('pressed')"), false, "and released");
  await page.evaluate("PCE_ST_APP.readMemory(0, 0x20000).then(function(b){ window.__ram = b; }); true");
  await page.waitFor("window.__ram", 5000, "RAM after");
  const found = await page.evaluate("(function(){var a=window.__before,b=window.__ram;for(var i=0;i<a.length;i++)if(a[i]!==b[i]&&b[i]===0x1e)return true;return false;})()");
  assert.ok(found, "scancode 0x1E appears in RAM after clicking A");
  await page.close();
});

test("on-screen modifiers: one tap holds until the next key, a double tap locks, a tap unlocks", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnKeyboard')");
  await page.evaluate(RECORD_KEYS);
  const shift = await centerOf(page, '#stKeyboard [data-code="ShiftLeft"]');
  const a = await centerOf(page, '#stKeyboard [data-code="KeyA"]');
  const state = function () { return page.evaluate("PCE_ST_KEYBOARD.getModifierState('ShiftLeft')"); };

  // One tap: held (amber), released after the next ordinary key.
  await page.mouse("mouseMoved", shift.x, shift.y);
  await page.mouse("mousePressed", shift.x, shift.y, "left"); await page.mouse("mouseReleased", shift.x, shift.y, "left");
  assert.strictEqual(await state(), "latched");
  assert.strictEqual(await page.evaluate("document.querySelector('#stKeyboard [data-code=\"ShiftLeft\"]').classList.contains('latched')"), true);
  await clickAt(page, a); await page.sleep(100);
  assert.strictEqual(await state(), "off", "released after the key");
  assert.deepStrictEqual(await page.evaluate("window.__keys"), ["down:ShiftLeft", "down:KeyA", "up:KeyA", "up:ShiftLeft"]);

  // Double tap: locked (red); it survives ordinary keys.
  await page.evaluate("window.__keys = []; true");
  await page.mouse("mouseMoved", shift.x, shift.y);
  for (let i = 0; i < 2; i++) { await page.mouse("mousePressed", shift.x, shift.y, "left"); await page.mouse("mouseReleased", shift.x, shift.y, "left"); }
  assert.strictEqual(await state(), "locked");
  await clickAt(page, a); await page.sleep(100);
  assert.strictEqual(await state(), "locked", "still locked after a key");
  // A later single tap unlocks it.
  await page.sleep(500);
  await page.mouse("mouseMoved", shift.x, shift.y);
  await page.mouse("mousePressed", shift.x, shift.y, "left"); await page.mouse("mouseReleased", shift.x, shift.y, "left");
  assert.strictEqual(await state(), "off");
  assert.deepStrictEqual(await page.evaluate("window.__keys"), ["down:ShiftLeft", "down:KeyA", "up:KeyA", "up:ShiftLeft"]);

  // Hiding the keyboard lets go of anything still held.
  await page.evaluate("window.__keys = []; true");
  await page.mouse("mouseMoved", shift.x, shift.y);
  await page.mouse("mousePressed", shift.x, shift.y, "left"); await page.mouse("mouseReleased", shift.x, shift.y, "left");
  await page.evaluate("__click('btnKeyboard')");
  assert.deepStrictEqual(await page.evaluate("window.__keys"), ["down:ShiftLeft", "up:ShiftLeft"]);
  await page.close();
});

test("a physical key lights up its on-screen key", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnKeyboard')");
  await page.evaluate("document.getElementById('screen').focus(); true");
  const lit = "document.querySelector('#stKeyboard [data-code=\"KeyQ\"]').classList.contains('pressed')";
  await page.key("rawKeyDown", "KeyQ", "q", 81);
  assert.strictEqual(await page.evaluate(lit), true, "lit while held");
  await page.key("keyUp", "KeyQ", "q", 81);
  assert.strictEqual(await page.evaluate(lit), false, "off after release");
  await page.close();
});

test("the on-screen joystick: dragging the stick and the fire button reach the machine", async function () {
  const page = await openPage();
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getJoystickEnabled()"), false);
  await page.evaluate("__click('btnJoystick')");
  assert.strictEqual(await page.evaluate("document.getElementById('joystickPanel').hidden"), false);
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getJoystickEnabled()"), true);
  const port1 = function () { return page.evaluate("PCE_ST_APP.getJoystickState().then(function(s){return s.port1;})"); };
  await page.sleep(300);
  assert.strictEqual(await port1(), 0);

  const stick = await centerOf(page, "#joystickStick");
  await page.mouse("mouseMoved", stick.x, stick.y);
  await page.mouse("mousePressed", stick.x, stick.y, "left");
  await page.mouse("mouseMoved", stick.x, stick.y - 25); await page.sleep(150);
  assert.strictEqual(await port1(), 0x01, "up");
  assert.strictEqual(await page.evaluate("document.getElementById('glowUp').classList.contains('active')"), true, "the indicator lights");
  await page.mouse("mouseMoved", stick.x - 25, stick.y - 25); await page.sleep(150);
  assert.strictEqual(await port1(), 0x05, "up + left");
  await page.mouse("mouseReleased", stick.x - 25, stick.y - 25, "left"); await page.sleep(150);
  assert.strictEqual(await port1(), 0, "released");

  const fire = await centerOf(page, "#fireButton");
  await page.mouse("mouseMoved", fire.x, fire.y);
  await page.mouse("mousePressed", fire.x, fire.y, "left"); await page.sleep(150);
  assert.strictEqual(await port1(), 0x80, "fire");
  await page.mouse("mouseReleased", fire.x, fire.y, "left"); await page.sleep(150);
  assert.strictEqual(await port1(), 0);

  await page.evaluate("__click('btnJoystick')");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getJoystickEnabled()"), false, "off when hidden");
  await page.close();
});

test("the joystick mode survives a machine restart", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnJoystick')");
  await page.evaluate("PCE_ST_APP.powerCycle().then(function(){ return true; })");
  await page.waitFor("PCE_ST_APP.isRunning()", 20000, "running after the restart");
  await page.evaluate("PCE_ST_APP.joystick({ up: true, fire: true }); true");
  await page.waitFor("PCE_ST_APP.getJoystickState().then(function(s){ return s.port1 === 0x81; })", 5000, "up + fire after the restart");
  await page.close();
});

test("on a phone, the action bar shows one input device at a time", async function () {
  const page = await openPage();
  await page.setViewport(420, 800, true);
  await page.sleep(500);
  const hidden = function (id) { return page.evaluate("document.getElementById('" + id + "').hidden"); };
  await page.evaluate("document.querySelector('[data-mobile-input=keyboard]').click(); true");
  assert.strictEqual(await hidden("keyboardPanel"), false);
  assert.strictEqual(await hidden("joystickPanel"), true);
  await page.evaluate("document.querySelector('[data-mobile-input=joystick]').click(); true");
  assert.strictEqual(await hidden("joystickPanel"), false);
  assert.strictEqual(await hidden("keyboardPanel"), true, "the keyboard is hidden when the joystick is shown");
  await page.evaluate("document.querySelector('[data-mobile-input=joystick]').click(); true");
  assert.strictEqual(await hidden("joystickPanel"), true);
  await page.close();
});

test("touch works as a trackpad: dragging moves the TOS cursor", async function () {
  const page = await openPage();
  await reachDesktop(page);
  const box = await page.evaluate("(function(){var r=document.getElementById('screen').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await page.setViewport(1300, 900, true);
  await page.sleep(500);
  await page.evaluate("__shot()"); await page.evaluate("__mark()");
  await page.touch("touchStart", [{ x: box.x, y: box.y }]);
  for (let i = 1; i <= 10; i++) { await page.touch("touchMove", [{ x: box.x + i * 10, y: box.y + i * 5 }]); await page.sleep(30); }
  await page.touch("touchEnd", []);
  await page.sleep(400);
  await page.evaluate("__shot()");
  const moved = await page.evaluate("__diff(0,0,640,400)");
  assert.ok(moved > 20, "the TOS cursor moved with the touch drag (" + moved + " different pixels)");
  await page.close();
});

test("on a phone-sized screen the mobile tools sheet opens and closes", async function () {
  const page = await openPage();
  await page.setViewport(420, 800, true);
  await page.sleep(500);
  assert.strictEqual(await page.evaluate("getComputedStyle(document.getElementById('mobileActionBar')).display !== 'none'"), true, "the mobile action bar is visible");
  await page.evaluate("__click('mobileToolsButton')");
  assert.strictEqual(await page.evaluate("document.getElementById('mobileToolsSheet').hidden"), false);
  await page.evaluate("__click('mobileToolsClose')");
  assert.strictEqual(await page.evaluate("document.getElementById('mobileToolsSheet').hidden"), true);
  await page.close();
});

test("the ROM notice exists, is wired up and stays hidden while a ROM is loaded", async function () {
  const page = await openPage();
  const info = await page.evaluate(`({
    hasNotice: !!document.getElementById('romNotice'),
    hidden: document.getElementById('romNotice').hidden,
    title: document.getElementById('romNoticeTitle').textContent,
  })`);
  assert.strictEqual(info.hasNotice, true);
  assert.strictEqual(info.hidden, true, "hidden while a ROM is loaded");
  assert.strictEqual(info.title, "System ROM required");
  await page.close();
});

test("the Work layout shows the floppy library: upload, mount in A:, search, trash", async function () {
  const page = await openPage();
  const tag = "W" + Date.now().toString(36).toUpperCase().slice(-7);
  assert.strictEqual(await page.evaluate("document.getElementById('diskLibraryPanel').hidden"), true, "hidden in the Emulation layout");
  await page.evaluate("__click('btnLayoutWork')");
  assert.strictEqual(await page.evaluate("document.querySelector('.layout').dataset.layoutScheme"), "work");
  assert.strictEqual(await page.evaluate("document.getElementById('diskLibraryPanel').hidden"), false);
  assert.strictEqual(await page.evaluate("getComputedStyle(document.getElementById('layoutSplitter')).display"), "flex");
  // Upload two files through the panel's input.
  const img = makeBlankST("UPLOAD", [{ name: "A.TXT", data: "x" }]);
  const upload = "(function(){var dt=new DataTransfer();" +
    "dt.items.add(new File([Uint8Array.from(atob('" + img.toString("base64") + "'),function(c){return c.charCodeAt(0);})],'" + tag + ".st'));" +
    "dt.items.add(new File([new Uint8Array([0x60,0x1a,0,0])],'" + tag + "P.prg'));" +
    "var i=document.querySelector('.disklib-upload-input');i.files=dt.files;i.dispatchEvent(new Event('change'));return true;})()";
  await page.evaluate(upload);
  const rows = "Array.from(document.querySelectorAll('.disklib-list .disklib-row')).filter(function(r){return r.textContent.indexOf('" + tag + "')>=0;})";
  await page.waitFor(rows + ".length === 2", 5000, "two rows in the list");
  await page.screenshot("/tmp/pce-st-library.png");
  // Mount the floppy in A: with its checkbox.
  await page.evaluate("(function(){var r=" + rows + ".filter(function(r){return r.textContent.indexOf('" + tag + ".st')>=0;})[0];r.querySelectorAll('.disklib-drive-chk')[0].click();return true;})()");
  await page.waitFor("PCE_ST_APP.hasMountedFloppy(0)", 5000, "mounted in A:");
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getFloppyInfo(0).name"), tag + ".st");
  await page.waitFor("document.querySelector('.disklib-mounted-list').textContent.indexOf('A:')>=0", 3000, "the mounted strip shows A:");
  // The search filters by name.
  await page.evaluate("(function(){var i=document.querySelector('.disklib-search-input');i.value='" + tag + "P';i.dispatchEvent(new Event('input'));return true;})()");
  await page.waitFor("Array.from(document.querySelectorAll('.disklib-list .disklib-row')).length === 1", 3000, "search narrows the list");
  await page.evaluate("(function(){var i=document.querySelector('.disklib-search-input');i.value='';i.dispatchEvent(new Event('input'));return true;})()");
  // Delete with the confirm dialog accepted: the entries go to the trash.
  await page.evaluate("window.confirm = function(){return true;}; true");
  await page.evaluate("PCE_ST_LIBRARY.unmountFile(PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name==='" + tag + ".st';})[0].id)");
  await page.evaluate("Promise.all(PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name.indexOf('" + tag + "')===0;}).map(function(f){return PCE_ST_LIBRARY.deleteFile(f.id);}))");
  assert.strictEqual(await page.evaluate("PCE_ST_LIBRARY.listTrash().filter(function(f){return f.name.indexOf('" + tag + "')===0;}).length"), 2);
  await page.evaluate("Promise.all(PCE_ST_LIBRARY.listTrash().filter(function(f){return f.name.indexOf('" + tag + "')===0;}).map(function(f){return PCE_ST_LIBRARY.purgeTrash(f.id);}))");
  // The layout choice is remembered.
  assert.strictEqual(await page.evaluate("localStorage.getItem('pce_st_layout_scheme')"), "work");
  await page.close();
});

test("the splitter resizes the library column", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnLayoutWork')");
  const before = await page.evaluate("document.getElementById('diskLibraryPanel').getBoundingClientRect().width");
  const box = await centerOf(page, "#layoutSplitter");
  await page.mouse("mouseMoved", box.x, box.y);
  await page.mouse("mousePressed", box.x, box.y, "left");
  await page.mouse("mouseMoved", box.x + 120, box.y);
  await page.mouse("mouseReleased", box.x + 120, box.y, "left");
  const after = await page.evaluate("document.getElementById('diskLibraryPanel').getBoundingClientRect().width");
  assert.ok(after > before + 60, "the column grew (" + before + " -> " + after + ")");
  await page.close();
});

test("on a phone the library opens as a full-screen sheet and the backdrop closes it", async function () {
  const page = await openPage();
  await page.setViewport(390, 780, true);
  await page.sleep(400);
  await page.evaluate("__click('mobileToolsButton')");
  await page.evaluate("document.querySelector('[data-mobile-proxy=btnDiskLibrary]').click()");
  assert.strictEqual(await page.evaluate("document.getElementById('diskLibraryPanel').hidden"), false);
  assert.strictEqual(await page.evaluate("document.body.classList.contains('mobile-panel-open')"), true);
  assert.strictEqual(await page.evaluate("getComputedStyle(document.querySelector('.layoutTools')).display"), "grid");
  await page.evaluate("document.getElementById('mobilePanelBackdrop').click()");
  assert.strictEqual(await page.evaluate("document.getElementById('diskLibraryPanel').hidden"), true);
  assert.strictEqual(await page.evaluate("document.body.classList.contains('mobile-panel-open')"), false);
  await page.close();
});

test("a loaded ROM is kept in the ROM library and chosen again after a reload", async function () {
  const page = await openPage();
  const rom = fs.readFileSync(path.join(__dirname, "..", "..", "roms", "emutos", "etos192us.img"));
  assert.strictEqual(await page.evaluate("document.getElementById('romSelect').options.length"), 1);
  await page.evaluate(pickFile("romInput", rom, "kept_tos.img"));
  await page.waitFor("document.getElementById('romName').textContent === 'kept_tos'", 15000, "ROM label");
  await page.waitFor("document.getElementById('romSelect').value === 'kept_tos'", 5000, "ROM listed and selected");
  assert.strictEqual(await page.evaluate("document.getElementById('btnRemoveRom').disabled"), false);
  await page.close(true);
  const again = await openPage();
  assert.strictEqual(await again.evaluate("document.getElementById('romName').textContent"), "kept_tos", "the stored ROM is used");
  await again.waitFor("document.getElementById('romSelect').value === 'kept_tos'", 5000, "ROM selected again");
  // Back to the built-in ROM, then remove the stored one.
  await again.evaluate("__select('romSelect', '')");
  await again.waitFor("document.getElementById('romName').textContent === 'EmuTOS'", 15000, "built-in ROM");
  await again.evaluate("__select('romSelect', 'kept_tos')");
  await again.waitFor("document.getElementById('romName').textContent === 'kept_tos'", 15000, "stored ROM");
  await again.evaluate("__click('btnRemoveRom')");
  await again.waitFor("document.getElementById('romName').textContent === 'EmuTOS' && document.getElementById('romSelect').options.length === 1", 15000, "ROM removed");
  await again.close();
});

test("the floppies mounted in A: and B: come back after a reload", async function () {
  const page = await openPage();
  const img = makeBlankST("KEEP", [{ name: "K.TXT", data: "keep" }]);
  await page.evaluate(pickFile("disk1", img, "keep_me.st"));
  await page.waitFor("PCE_ST_APP.hasMountedFloppy(0)", 5000, "mounted through the toolbar");
  assert.strictEqual(await page.evaluate("PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name==='keep_me.st'&&f.mountedSlot===0;}).length"), 1, "the toolbar goes through the library");
  await page.sleep(500);                       // let the library finish writing to IndexedDB
  await page.close(true);
  const again = await openPage();
  await again.waitFor("PCE_ST_APP.hasMountedFloppy(0)", 8000, "floppy restored in A:");
  assert.strictEqual(await again.evaluate("PCE_ST_APP.getFloppyInfo(0).name"), "keep_me.st");
  // Opening the same file name again adds a revision instead of failing.
  await again.evaluate(pickFile("disk1", makeBlankST("KEEP2", []), "keep_me.st"));
  await again.waitFor("PCE_ST_LIBRARY.listRevisions(PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name==='keep_me.st';})[0].id).length === 2", 5000, "second revision");
  await again.close();
});

test("a change the guest makes to a mounted floppy is saved in the library", async function () {
  const page = await openPage();
  await reachDesktop(page);
  const tag = "G" + Date.now().toString(36).toUpperCase().slice(-7);
  const img = makeBlankST("GUEST", [{ name: "HELLO.TXT", data: "hello" }]);
  await page.evaluate("(async function(){var f=await PCE_ST_LIBRARY.addFile('" + tag + ".ST', Uint8Array.from(atob('" + img.toString("base64") + "'),function(c){return c.charCodeAt(0);}));" +
    "await PCE_ST_LIBRARY.mountFile(f.id,0); window.__gid=f.id; return true;})()");
  // Drive the desktop with the clock stopped between inputs (as the core tests do):
  // open A:, create a folder named X (Ctrl+N), then let the machine run again.
  await page.evaluate("(async function(){var A=PCE_ST_APP;await A.pause();var f=function(n){return A.stepFrames(n);};" +
    "await f(20);" +
    "for(var i=0;i<6;i++){A.mouse(-50,-28,0);await f(2);} A.mouse(15,6,0); await f(8);" +
    "for(var k=0;k<2;k++){A.mouse(0,0,1);await f(2);A.mouse(0,0,0);await f(3);} await f(200);" +
    "var press=async function(c){A.onKeyDown(c);await f(4);A.onKeyUp(c);await f(4);};" +
    "A.onKeyDown('ControlLeft'); await f(3); await press('KeyN'); A.onKeyUp('ControlLeft'); await f(60);" +
    "await press('KeyX'); await press('Enter'); await f(1200); await A.start(); return true;})()");
  try {
    await page.waitFor("PCE_ST_LIBRARY.listRevisions(window.__gid).length >= 2", 60000, "the guest's change became a revision");
  } catch (err) {
    await page.screenshot("/tmp/pce-st-guest.png");
    console.log(JSON.stringify(await page.evaluate("[PCE_ST_APP.getFloppyInfo(0), PCE_ST_APP.getStats()]")));
    throw err;
  }
  // The guest keeps writing for a while; the library follows it. Wait for the end state.
  let names = [];
  for (let i = 0; i < 40; i++) {
    const bytes = await page.evaluate("PCE_ST_LIBRARY.downloadFile(window.__gid).then(function(r){return Array.from(new Uint8Array(r.buffer));})");
    names = listRoot(Buffer.from(bytes)).map(function (e) { return e.name; }).sort();
    if (names.length === 2) break;
    await page.sleep(1000);
  }
  assert.deepStrictEqual(names, ["HELLO.TXT", "X"]);
  await page.evaluate("PCE_ST_LIBRARY.unmountFile(window.__gid).then(function(){return PCE_ST_LIBRARY.deleteFile(window.__gid);})");
  await page.close();
});

test("an MSA image is uploaded as a floppy and its files can be viewed and previewed", async function () {
  const page = await openPage();
  const tag = "M" + Date.now().toString(36).toUpperCase().slice(-7);
  const raw = makeBlankST("MSATEST", [{ name: "NOTE.TXT", data: "hello from msa" }]);
  // An uncompressed MSA: header, then every track as a 2-byte length and its bytes.
  const parts = [Buffer.from([0x0e, 0x0f, 0, 9, 0, 1, 0, 0, 0, 79])];
  for (let t = 0; t < 160; t++) {
    const len = Buffer.alloc(2); len.writeUInt16BE(4608, 0);
    parts.push(len, raw.subarray(t * 4608, (t + 1) * 4608));
  }
  const msa = Buffer.concat(parts);
  await page.evaluate("__click('btnLayoutWork')");
  await page.evaluate("(function(){var dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('" + msa.toString("base64") + "'),function(c){return c.charCodeAt(0);})],'" + tag + ".msa'));" +
    "var i=document.querySelector('.disklib-upload-input');i.files=dt.files;i.dispatchEvent(new Event('change'));return true;})()");
  const row = "Array.from(document.querySelectorAll('.disklib-list .disklib-row')).filter(function(r){return r.textContent.indexOf('" + tag + ".st')>=0;})[0]";
  await page.waitFor(row, 5000, "the MSA became a .st entry");
  await page.evaluate(row + ".querySelector('[aria-label=\\'View the files on the floppy\\']').click()");
  await page.waitFor("!document.querySelector('.disklib-atr-view').hidden && document.querySelector('.disklib-atr-list').textContent.indexOf('NOTE.TXT')>=0", 5000, "the contents view lists NOTE.TXT");
  assert.ok(await page.evaluate("document.querySelector('.disklib-atr-info').textContent.indexOf('Label: MSATEST')>=0"), "the label is shown");
  await page.evaluate("document.querySelector('.disklib-atr-row [aria-label=\\'Preview NOTE.TXT\\']').click()");
  assert.ok(await page.evaluate("document.querySelector('.disklib-atr-preview-text').textContent.indexOf('hello from msa')>=0"), "the preview shows the text");
  await page.screenshot("/tmp/pce-st-contents.png");
  await page.evaluate("document.querySelector('.disklib-atr-back-btn').click()");
  assert.strictEqual(await page.evaluate("document.querySelector('.disklib-atr-view').hidden"), true);
  await page.evaluate("PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name.indexOf('" + tag + "')===0;}).forEach(function(f){PCE_ST_LIBRARY.deleteFile(f.id);})");
  await page.close();
});

test("a library exported as a package can be imported again through the panel", async function () {
  const page = await openPage();
  const tag = "P" + Date.now().toString(36).toUpperCase().slice(-7);
  await page.evaluate("__click('btnLayoutWork')");
  await page.evaluate("(async function(){var L=PCE_ST_LIBRARY;var f=await L.addFile('" + tag + ".ST',PCE_STImage.createFloppy({label:'PKG',files:[{name:'A.TXT',data:new Uint8Array([65])}]}));" +
    "var e=await L.exportPackage({fileName:'x.pcest'});window.__pkg=new Uint8Array(e.buffer);" +
    "await L.deleteFile(f.id);await L.purgeTrash(L.listTrash().filter(function(t){return t.name==='" + tag + ".ST';})[0].id);return true;})()");
  assert.strictEqual(await page.evaluate("PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name==='" + tag + ".ST';}).length"), 0);
  await page.evaluate("window.confirm=function(){return true;};(function(){var dt=new DataTransfer();dt.items.add(new File([window.__pkg],'x.pcest'));" +
    "var i=document.querySelector('.disklib-import-input');i.files=dt.files;i.dispatchEvent(new Event('change'));return true;})()");
  await page.waitFor("PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name==='" + tag + ".ST';}).length===1", 8000, "the entry is back after the import");
  const report = await page.evaluate("PCE_ST_LIBRARY.verifyFile(PCE_ST_LIBRARY.listFiles().filter(function(f){return f.name==='" + tag + ".ST';})[0].id).then(function(r){return r.valid;})");
  assert.strictEqual(report, true, "the imported floppy is intact");
  await page.evaluate("PCE_ST_LIBRARY.listFiles().forEach(function(f){PCE_ST_LIBRARY.deleteFile(f.id);})");
  await page.close();
});

test("the snapshot panel saves and restores the whole machine (quick slot and file)", async function () {
  const page = await openPage();
  await page.evaluate("__click('btnSnapshots')");
  assert.strictEqual(await page.evaluate("document.getElementById('snapshotPanel').hidden"), false);
  const peek = "PCE_ST_APP.readMemory(0x20000, 4).then(function(b){return Array.from(b);})";
  await page.evaluate("PCE_ST_APP.writeMemory(0x20000, [1, 2, 3, 4])");
  await page.evaluate("document.querySelector('.snapshot-save-btn').click()");
  await page.waitFor("document.querySelector('.snapshot-status').textContent.indexOf('saved')>=0", 15000, "snapshot saved");
  assert.strictEqual(await page.evaluate("document.querySelector('.snapshot-slot-state').textContent"), "Saved");
  assert.strictEqual(await page.evaluate("document.querySelector('.snapshot-load-btn').disabled"), false);
  await page.evaluate("PCE_ST_APP.writeMemory(0x20000, [9, 9, 9, 9])");
  assert.deepStrictEqual(await page.evaluate(peek), [9, 9, 9, 9]);
  await page.evaluate("document.querySelector('.snapshot-load-btn').click()");
  await page.waitFor("document.querySelector('.snapshot-status').textContent.indexOf('restored')>=0", 15000, "snapshot restored");
  assert.deepStrictEqual(await page.evaluate(peek), [1, 2, 3, 4], "the quick slot restores the memory");
  // File round trip: encode what the panel would export and import it through the input.
  await page.evaluate("PCE_ST_APP.writeMemory(0x20000, [5, 6, 7, 8])");
  await page.evaluate("(async function(){var s=await PCE_ST_APP.saveSnapshot();window.__file=await PCE_STSnapshot.encode({config:s.config,romLabel:'EmuTOS',memory:s.memory,floppies:s.floppies});return true;})()");
  await page.evaluate("PCE_ST_APP.writeMemory(0x20000, [0, 0, 0, 0])");
  await page.evaluate("(function(){var dt=new DataTransfer();dt.items.add(new File([window.__file],'x.pcestsnap'));var i=document.querySelector('.snapshot-import-input');i.files=dt.files;i.dispatchEvent(new Event('change'));return true;})()");
  await page.waitFor("document.querySelector('.snapshot-status').textContent.indexOf('imported')>=0", 15000, "snapshot imported");
  assert.deepStrictEqual(await page.evaluate(peek), [5, 6, 7, 8], "the file restores the memory");
  // A snapshot from another ROM is refused with a clear message.
  await page.evaluate("(async function(){var s=await PCE_ST_APP.saveSnapshot();window.__other=await PCE_STSnapshot.encode({config:s.config,romLabel:'Other TOS',memory:s.memory,floppies:s.floppies});return true;})()");
  await page.evaluate("(function(){var dt=new DataTransfer();dt.items.add(new File([window.__other],'y.pcestsnap'));var i=document.querySelector('.snapshot-import-input');i.files=dt.files;i.dispatchEvent(new Event('change'));return true;})()");
  await page.waitFor("document.querySelector('.snapshot-status').textContent.indexOf('needs the ROM')>=0", 15000, "ROM mismatch message");
  await page.close();
});

test("a physical gamepad drives the joystick, even with the on-screen joystick hidden", async function () {
  const page = await openPage();
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getJoystickEnabled()"), false);
  await page.evaluate("window.__pad = { connected: true, axes: [0, 0], buttons: [{pressed:false,value:0}] };" +
    "navigator.getGamepads = function(){ return [window.__pad]; };" +
    "window.dispatchEvent(new Event('gamepadconnected')); true");
  await page.sleep(200);
  assert.strictEqual(await page.evaluate("PCE_ST_APP.getJoystickEnabled()"), false, "an idle pad changes nothing");
  await page.evaluate("window.__pad.axes = [-1, 0]; window.__pad.buttons = [{pressed:true,value:1}]; true");
  await page.waitFor("PCE_ST_APP.getJoystickEnabled()", 3000, "using the pad turns the joystick mode on");
  await page.waitFor("PCE_ST_APP.getJoystickState().then(function(s){return (s.port1 & 0x84) === 0x84;})", 3000, "left + fire reach the machine");
  assert.strictEqual(await page.evaluate("document.getElementById('joystickPanel').hidden"), true, "the panel stays hidden");
  await page.evaluate("window.__pad.axes = [0, 0]; window.__pad.buttons = [{pressed:false,value:0}]; true");
  await page.waitFor("PCE_ST_APP.getJoystickState().then(function(s){return (s.port1 & 0x84) === 0;})", 3000, "released");
  await page.close();
});

(async function main() {
  const only = process.argv.find(function (a) { return a.indexOf("--only=") === 0; });
  const filter = only ? only.slice(7) : null;
  if (!fs.existsSync(path.join(OUT, "pce_st_core.wasm"))) {
    console.error("Missing build/out/pce_st_core.wasm: run scripts/build-core.sh");
    process.exit(2);
  }
  const server = await start(0);
  base = "http://127.0.0.1:" + server.address().port;
  chrome = await launch();
  let failed = 0;
  try {
    for (const t of tests) {
      if (filter && t.name.indexOf(filter) < 0) continue;
      const t0 = Date.now();
      try {
        await t.fn();
        console.log("ok   - " + t.name + " (" + (Date.now() - t0) + " ms)");
      } catch (err) {
        failed++;
        console.log("FAIL - " + t.name + "\n       " + (err && err.message ? err.message : err));
      }
    }
  } finally {
    await chrome.close();
    server.close();
  }
  console.log(failed ? failed + " test(s) failed" : "all tests passed");
  process.exit(failed ? 1 : 0);
})();
