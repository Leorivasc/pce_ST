"use strict";
// Tests of web/index.html in a real (headless) Chrome.
//
// Usage:  node tests/browser/browser.test.js
// Requirements: scripts/build-core.sh already run and Chrome/Chromium installed
// (or CHROME=/path/to/browser). It starts its own server on a free port.
//
// Audio and video are checked inside the page (PCE_ST_DEBUG): the video is
// drawn on the worker's OffscreenCanvas and cannot be read from the main thread.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { start } = require("../../scripts/serve.js");
const { launch } = require("./cdp.js");
const { makeBlankST } = require("../core/stimage.js");

const OUT = path.join(__dirname, "..", "..", "build", "out");
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

let base = "";
let chrome = null;

// In-page helpers: screenshots and comparisons without moving the whole buffer out.
const PAGE_HELPERS = `
  window.__shot = async function () { window.__last = await PCE_ST_DEBUG.screenshot(); return [window.__last.width, window.__last.height]; };
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
  true;
`;

async function openPage(query) {
  const page = await chrome.openPage(base + "/web/index.html?" + (query || "autostart=1"));
  await page.waitFor("window.PCE_ST_DEBUG && true", 15000, "page loaded");
  await page.evaluate(PAGE_HELPERS);
  return page;
}

function setSpeed(page, value) {
  return page.evaluate("(function(){var s=document.getElementById('speed');s.value='" + value + "';s.dispatchEvent(new Event('change'));return true;})()");
}

// Waits for the EmuTOS desktop to be drawn (monochrome), using turbo.
async function reachDesktop(page) {
  await page.waitFor("PCE_ST_DEBUG.state().running", 15000, "emulation running");
  await setSpeed(page, 0);
  // Desktop: dotted background (~48 % dark pixels, not all black like a freshly
  // created buffer) and text in the menu bar.
  await page.waitFor("(async function(){ await __shot(); var bar = __dark(0,0,640,18), bg = __dark(0,100,640,390);" +
    " return bar > 200 && bar < 4000 && bg > 70000 && bg < 120000; })()",
    40000, "EmuTOS desktop");
  await setSpeed(page, 1);
}

async function noPageErrors(page) {
  const err = await page.evaluate("document.getElementById('error').textContent");
  assert.strictEqual(err, "", "error visible on the page: " + err);
  const bad = page.console.filter(function (l) { return /EXCEPTION|error:/i.test(l); });
  assert.deepStrictEqual(bad, [], "errors in the console");
}

test("starts in Chrome and runs in real time (~71 fps, 1.0x) with audio active", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_DEBUG.state().stats", 15000, "statistics");
  await page.sleep(3500);
  const st = await page.evaluate("PCE_ST_DEBUG.state()");
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.video.width, 640);
  assert.strictEqual(st.video.height, 400);
  assert.ok(st.stats.speed > 0.9 && st.stats.speed < 1.1, "speed " + st.stats.speed);
  assert.ok(st.stats.fps > 60 && st.stats.fps < 80, "fps " + st.stats.fps);
  assert.strictEqual(st.audioState, "running");
  assert.ok(st.audio.underruns <= 1, "audio underruns " + st.audio.underruns);
  await noPageErrors(page);
  await page.close();
});

test("turbo speeds up emulation and reaches the desktop", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_DEBUG.state().running", 15000);
  await setSpeed(page, 0);
  await page.sleep(1500);
  const turbo = await page.evaluate("PCE_ST_DEBUG.state().stats.speed");
  assert.ok(turbo > 2, "turbo speed " + turbo);
  await reachDesktop(page);
  await page.sleep(2500);
  const back = await page.evaluate("PCE_ST_DEBUG.state().stats.speed");
  assert.ok(back > 0.9 && back < 1.1, "back to real time: " + back);
  await page.evaluate("__shot()");
  await page.close();
});

test("the real keyboard (Chrome events) reaches TOS: the A key leaves its code in RAM", async function () {
  const page = await openPage();
  await reachDesktop(page);
  await page.evaluate("document.getElementById('screen').focus(); window.__ram = null; PCE_ST_DEBUG.peek(0, 0x20000).then(function(b){ window.__ram = b; }); true");
  await page.waitFor("window.__ram", 5000, "RAM before");
  await page.evaluate("window.__before = window.__ram; window.__ram = null; true");
  // ~80 ms pauses (several frames) between events, like a person.
  await page.key("rawKeyDown", "KeyA", "a", 65); await page.sleep(80);
  await page.key("keyUp", "KeyA", "a", 65); await page.sleep(200);
  await page.evaluate("PCE_ST_DEBUG.peek(0, 0x20000).then(function(b){ window.__ram = b; }); true");
  await page.waitFor("window.__ram", 5000, "RAM after");
  const found = await page.evaluate("(function(){var a=window.__before,b=window.__ram;for(var i=0;i<a.length;i++)if(a[i]!==b[i]&&b[i]===0x1e)return true;return false;})()");
  assert.ok(found, "scancode 0x1E appears in RAM after pressing A");
  await page.close();
});

test("audio reaches the worklet: silence at rest, a tone with signal, and back to silence", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_DEBUG.state().stats", 15000);
  function psg(reg, val) {
    return "PCE_ST_DEBUG.send({type:'poke',addr:0xff8800,value:" + reg + "});PCE_ST_DEBUG.send({type:'poke',addr:0xff8802,value:" + val + "});";
  }
  await page.waitFor("PCE_ST_DEBUG.state().audio.peak === 0", 6000, "silence at startup (no clicks)");
  await page.evaluate(psg(0, 0xc0) + psg(1, 0x01) + psg(7, 0x3e) + psg(8, 0x0f) + "true");
  await page.waitFor("PCE_ST_DEBUG.state().audio.peak > 0.1", 6000, "the worklet plays the tone");
  assert.ok(await page.evaluate("PCE_ST_DEBUG.state().audio.peak < 0.6"), "does not clip");
  await page.evaluate(psg(8, 0) + "true");
  await page.waitFor("PCE_ST_DEBUG.state().audio.peak === 0", 8000, "back to silence");
  await page.close();
});

test("pausing stops the clock and resuming restarts it", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_DEBUG.state().stats", 15000);
  await page.evaluate("document.getElementById('pause').click(); true");
  await page.waitFor("PCE_ST_DEBUG.state().running === false", 5000, "paused");
  await page.sleep(1200);
  const c1 = await page.evaluate("PCE_ST_DEBUG.state().stats.clock");
  await page.sleep(800);
  const c2 = await page.evaluate("PCE_ST_DEBUG.state().stats.clock");
  assert.strictEqual(c1, c2, "the clock does not advance while paused");
  await page.evaluate("document.getElementById('pause').click(); true");
  await page.waitFor("PCE_ST_DEBUG.state().running === true", 5000, "resumes");
  await page.sleep(1200);
  const c3 = await page.evaluate("PCE_ST_DEBUG.state().stats.clock");
  assert.ok(c3 > c2, "the clock advances after resuming");
  await page.close();
});

test("the color monitor starts at 320x200", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_DEBUG.state().running", 15000);
  await page.evaluate("(function(){var s=document.getElementById('monitor');s.value='color';s.dispatchEvent(new Event('change'));return true;})()");
  await page.waitFor("PCE_ST_DEBUG.state().video.width === 320 && PCE_ST_DEBUG.state().video.height === 200", 15000, "320x200");
  await noPageErrors(page);
  await page.close();
});

test("mount a .st floppy and get it back (round trip through the interface)", async function () {
  const page = await openPage();
  await page.waitFor("PCE_ST_DEBUG.state().running", 15000);
  const img = makeBlankST("WEBTEST", [{ name: "HELLO.TXT", data: "hello from the browser" }]);
  await page.evaluate("(function(){var b=Uint8Array.from(atob('" + img.toString("base64") + "'),function(c){return c.charCodeAt(0);});" +
    "PCE_ST_DEBUG.send({type:'mount',drive:0,bytes:b.buffer},[b.buffer]);return true;})()");
  await page.sleep(500);
  const r = await page.evaluate("PCE_ST_DEBUG.readFloppy(0).then(function(r){return {rc:r.rc,n:r.bytes&&r.bytes.length,sum:r.bytes&&r.bytes.reduce(function(a,b){return (a*31+b)>>>0;},0)};})");
  assert.strictEqual(r.rc, 0);
  assert.strictEqual(r.n, img.length);
  let sum = 0;
  for (let i = 0; i < img.length; i++) sum = (sum * 31 + img[i]) >>> 0;
  assert.strictEqual(r.sum, sum, "the floppy comes back identical");
  await page.close();
});

test("clicking the screen captures the mouse (Pointer Lock)", async function () {
  const page = await openPage();
  await reachDesktop(page);
  const box = await page.evaluate("(function(){var r=document.getElementById('screen').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await page.mouse("mouseMoved", box.x, box.y);
  await page.mouse("mousePressed", box.x, box.y, "left");
  await page.mouse("mouseReleased", box.x, box.y, "left");
  await page.waitFor("document.pointerLockElement === document.getElementById('screen')", 5000, "pointer captured");
  await page.close();
});

test("with the pointer captured, moving and pressing the mouse reaches the TOS cursor", async function () {
  const page = await openPage();
  await reachDesktop(page);
  const box = await page.evaluate("(function(){var r=document.getElementById('screen').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()");
  await page.mouse("mouseMoved", box.x, box.y);
  await page.mouse("mousePressed", box.x, box.y, "left");
  await page.mouse("mouseReleased", box.x, box.y, "left");
  await page.waitFor("document.pointerLockElement === document.getElementById('screen')", 5000, "pointer captured");
  await page.sleep(300);
  await page.evaluate("__shot()"); await page.evaluate("__mark()");
  for (let i = 1; i <= 12; i++) { await page.mouse("mouseMoved", box.x + i * 8, box.y + i * 4); await page.sleep(30); }
  await page.sleep(400);
  await page.evaluate("__shot()");
  const moved = await page.evaluate("__diff(0,0,640,400)");
  const sent = await page.evaluate("PCE_ST_DEBUG.state().mouseSent");
  assert.ok(moved > 20, "the TOS cursor moved (" + moved + " different pixels, " + sent + " mouse messages sent)");
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
