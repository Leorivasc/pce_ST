"use strict";
// Core tests (build/out/pce_st_core.js) in Node.
//
// Usage:  node tests/core/core.test.js
//   Uses the EmuTOS in roms/emutos/. For another ROM: pass its path as an
//   argument or set PCE_ST_ROM=/path/to/other.img
// Prerequisite: scripts/build-core.sh
//
// Each test creates its own module instance (independent memory), with the
// time fixed so that runs are reproducible.

const assert = require("assert");
const path = require("path");
const { createCore, writePng } = require("./harness.js");
const { makeBlankST, listRoot } = require("./stimage.js");

const OUT = path.join(__dirname, "..", "..", "build", "out");
const BOOT_FRAMES = 1600; // EmuTOS reaches the desktop around frame ~1300 (mono)
const ST_CPU_CLOCK = 8000000;

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function darkPixels(video, x0, y0, x1, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (video.rgb[(y * video.width + x) * 3] < 128) n++;
  }
  return n;
}

function diffPixels(a, b, x0, y0, x1, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 3;
      if (a.rgb[i] !== b.rgb[i]) n++;
    }
  }
  return n;
}

async function bootDesktop(opts) {
  const core = await createCore(opts);
  for (let i = 0; i < BOOT_FRAMES; i++) { core.stepFrame(); core.takeAudio(); }
  return core;
}

test("boots EmuTOS to the desktop (640x400 mono)", async function () {
  const core = await bootDesktop();
  const v = core.video();
  assert.strictEqual(v.width, 640);
  assert.strictEqual(v.height, 400);
  // Menu bar on top and a dotted background: lots of dark pixels, and the
  // first rows of the menu already contain text.
  assert.ok(darkPixels(v, 0, 0, 640, 400) > 100000, "desktop background");
  assert.ok(darkPixels(v, 0, 0, 640, 18) > 200, "menu bar");
  writePng(path.join(OUT, "desktop.png"), v.width, v.height, v.rgb);
});

test("is deterministic: two instances give the same state digest", async function () {
  const a = await createCore();
  const b = await createCore();
  a.stepFrames(300);
  b.stepFrames(300);
  assert.strictEqual(a.hash(), b.hash());
  a.mouse(10, 5, 0); b.mouse(10, 5, 0);
  a.stepFrames(20); b.stepFrames(20);
  assert.strictEqual(a.hash(), b.hash());
  const c = await createCore({ time: 1800000000 });
  c.stepFrames(320);
  assert.notStrictEqual(a.hash(), c.hash(), "a different time must change the state");
});

test("stepping by cycles is equivalent to stepping by frames", async function () {
  const a = await createCore();
  const b = await createCore();
  a.stepFrames(250);
  const cycles = a.clock();
  assert.strictEqual(cycles % 16, 0);
  b.stepCycles(cycles);
  assert.strictEqual(b.clock(), cycles);
  assert.strictEqual(b.hash(), a.hash());
});

test("audio follows emulated time", async function () {
  const core = await createCore();
  let total = 0;
  for (let i = 0; i < 400; i++) { core.stepFrame(); total += core.takeAudio().length; }
  const expected = Math.floor(core.clock() * 48000 / ST_CPU_CLOCK);
  assert.ok(Math.abs(total - expected) <= 1, "samples " + total + " expected " + expected);
  assert.strictEqual(core.audioDropped(), 0);
});

test("idle audio is exact silence (no DC offset)", async function () {
  const core = await createCore();
  for (let i = 0; i < 300; i++) {
    core.stepFrame();
    const a = core.takeAudio();
    for (let j = 0; j < a.length; j++) assert.strictEqual(a[j], 0, "non-zero sample in frame " + i);
  }
});

test("the PSG produces a tone at the programmed frequency", async function () {
  const core = await createCore();
  core.stepFrames(10);
  core.takeAudio();
  function psg(reg, val) { core.poke8(0xff8800, reg); core.poke8(0xff8802, val); }
  const period = 448; // f = 2 MHz / (16 * 448) = 279.0 Hz
  psg(0, period & 0xff); psg(1, period >> 8);
  psg(7, 0x3e);         // tone A only
  psg(8, 0x0f);         // maximum volume
  const samples = [];
  for (let i = 0; i < 36; i++) { // ~0.5 s in mono
    core.stepFrame();
    samples.push(core.takeAudio());
  }
  const all = Int16Array.from(samples.reduce(function (acc, s) { return acc.concat(Array.from(s)); }, []));
  let peak = 0;
  for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]));
  assert.ok(peak > 1000 && peak < 20000, "there is signal and it does not clip (peak " + peak + ")");
  // Zero crossings relative to the mean.
  let mean = 0; for (let i = 0; i < all.length; i++) mean += all[i]; mean /= all.length;
  assert.ok(Math.abs(mean) < 500, "signal centered on zero (mean " + mean.toFixed(0) + ")");
  let crossings = 0;
  for (let i = 1; i < all.length; i++) if ((all[i - 1] - mean) * (all[i] - mean) < 0) crossings++;
  const seconds = all.length / 48000;
  const freq = crossings / 2 / seconds;
  assert.ok(Math.abs(freq - 279) < 279 * 0.05, "measured frequency " + freq.toFixed(1) + " Hz");
});

test("the mouse moves the cursor and a click selects an icon", async function () {
  const core = await bootDesktop();
  const before = core.video();
  // Trash icon area (bottom left).
  const REGION = [10, 350, 70, 395];
  // The cursor starts near the center; move it to the trash in steps.
  for (let i = 0; i < 6; i++) { core.mouse(-50, 30, 0); core.stepFrames(2); }
  core.mouse(12, -14, 0); core.stepFrames(4); // on top of the icon
  core.stepFrames(5);
  const moved = core.video();
  assert.ok(diffPixels(before, moved, 0, 0, 640, 400) > 20, "the cursor moved");
  core.mouse(0, 0, 1); core.stepFrames(4);   // press
  core.mouse(0, 0, 0); core.stepFrames(30);  // release (GEM selects on release)
  const clicked = core.video();
  assert.ok(diffPixels(moved, clicked, REGION[0], REGION[1], REGION[2], REGION[3]) > 500,
    "the trash icon changes when it is selected");
  writePng(path.join(OUT, "click.png"), clicked.width, clicked.height, clicked.rgb);
});

test("the keyboard reaches TOS (the A key leaves its code in RAM)", async function () {
  const core = await bootDesktop();
  const RAM = 0x20000;
  function snapshot() { const a = new Uint8Array(RAM); for (let i = 0; i < RAM; i++) a[i] = core.peek8(i); return a; }
  const before = snapshot();
  const A = core.keyCode("a");
  assert.ok(A > 0, "pce_key_from_string('a')");
  core.key(1, A); core.stepFrames(6);
  core.key(2, A); core.stepFrames(6);
  const after = snapshot();
  let found = false;
  for (let i = 0; i < RAM; i++) if (before[i] !== after[i] && after[i] === 0x1e) { found = true; break; }
  assert.ok(found, "scancode 0x1E appears in RAM after pressing A");
});

// Moves the cursor to the drive A: icon (top left) and double-clicks.
// The ST cursor starts at the center of the screen (320, 200).
function openDriveA(core) {
  for (let i = 0; i < 6; i++) { core.mouse(-50, -28, 0); core.stepFrames(2); }
  core.mouse(15, 6, 0); core.stepFrames(8);
  for (let k = 0; k < 2; k++) { core.mouse(0, 0, 1); core.stepFrames(2); core.mouse(0, 0, 0); core.stepFrames(3); }
  core.stepFrames(200);
}

function typeKey(core, name) {
  const k = core.keyCode(name);
  core.key(1, k); core.stepFrames(4);
  core.key(2, k); core.stepFrames(4);
}

const WINDOW = [20, 100, 320, 290]; // the A: window

test("mounts a .st floppy and TOS reads its directory", async function () {
  const withFiles = await bootDesktop();
  const img1 = makeBlankST("TESTDISK", [
    { name: "HELLO.TXT", data: "hello atari st\r\n" },
    { name: "DATA.BIN", data: Buffer.alloc(3000, 7) },
  ]);
  assert.strictEqual(withFiles.mountFloppy(0, img1), 0);
  withFiles.stepFrames(20);
  const before = withFiles.video();
  openDriveA(withFiles);
  const win1 = withFiles.video();
  assert.ok(diffPixels(before, win1, WINDOW[0], WINDOW[1], WINDOW[2], WINDOW[3]) > 3000, "the A: window opens");
  writePng(path.join(OUT, "floppy.png"), win1.width, win1.height, win1.rgb);

  // With other files, the window contents change.
  const other = await bootDesktop();
  other.mountFloppy(0, makeBlankST("OTHER", [{ name: "ONLY.TXT", data: "x" }]));
  other.stepFrames(20);
  openDriveA(other);
  const win2 = other.video();
  assert.ok(diffPixels(win1, win2, WINDOW[0], WINDOW[1], WINDOW[2], WINDOW[3]) > 200, "the listing depends on the image");
});

test("guest writes reach the image when the floppy is flushed", async function () {
  const core = await bootDesktop();
  const img = makeBlankST("TESTDISK", [{ name: "HELLO.TXT", data: "hello atari st\r\n" }]);
  core.mountFloppy(0, img);
  core.stepFrames(20);
  openDriveA(core);
  assert.strictEqual(core.diskModified(0), false);
  // Ctrl+N creates a folder in the active window; it is named X.
  const ctrl = core.keyCode("Ctrl");
  core.key(1, ctrl); core.stepFrames(3); typeKey(core, "n"); core.key(2, ctrl); core.stepFrames(60);
  typeKey(core, "x"); typeKey(core, "Return");
  core.stepFrames(1200); // the emulated floppy is slow
  assert.strictEqual(core.diskModified(0), true, "the guest wrote to the floppy");
  assert.deepStrictEqual(listRoot(core.readFloppy(0)).map(function (e) { return e.name; }), ["HELLO.TXT"],
    "before flushing, the file does not change");
  assert.strictEqual(core.diskFlush(0), 0);
  assert.strictEqual(core.diskModified(0), false);
  const root = listRoot(core.readFloppy(0));
  assert.deepStrictEqual(root.map(function (e) { return e.name; }).sort(), ["HELLO.TXT", "X"]);
  assert.strictEqual(root.find(function (e) { return e.name === "X"; }).attr & 0x10, 0x10, "X is a directory");
});

test("mounting another image over a modified floppy does not mix the contents", async function () {
  const core = await bootDesktop();
  core.mountFloppy(0, makeBlankST("ONE", [{ name: "HELLO.TXT", data: "hello" }]));
  core.stepFrames(20);
  openDriveA(core);
  const ctrl = core.keyCode("Ctrl");
  core.key(1, ctrl); core.stepFrames(3); typeKey(core, "n"); core.key(2, ctrl); core.stepFrames(60);
  typeKey(core, "x"); typeKey(core, "Return");
  core.stepFrames(1200);
  assert.strictEqual(core.diskModified(0), true, "the guest modified the first floppy");

  const two = makeBlankST("TWO", [{ name: "OTHER.TXT", data: "different" }]);
  assert.strictEqual(core.mountFloppy(0, two), 0);
  core.stepFrames(20);
  assert.strictEqual(core.diskFlush(0), 0);
  assert.ok(core.readFloppy(0).equals(two), "after mounting the second image, the floppy is exactly that image");
});

test("snapshot: dumping WASM memory and restoring it in another instance continues identically", async function () {
  const a = await createCore();
  a.stepFrames(1400);
  a.mountFloppy(0, makeBlankST("SNAP", [{ name: "HELLO.TXT", data: "hello" }]));
  a.mouse(7, 4, 0);
  a.stepFrames(60);
  const snap = Buffer.from(a.M.HEAPU8);
  assert.ok(snap.length > 1 << 20);

  // Another instance: initialized the same way, the floppy file is recreated (it
  // lives in JS's file system, not in WASM memory) and the memory is restored.
  const b = await createCore();
  b.M.FS.mkdir("/disks");
  b.M.FS.writeFile("/disks/fd0.st", a.readFloppy(0));
  assert.strictEqual(b.M.HEAPU8.length, snap.length, "same amount of memory");
  b.M.HEAPU8.set(snap);
  assert.strictEqual(b.hash(), a.hash(), "the restored state matches");

  a.mouse(-3, 2, 1); b.mouse(-3, 2, 1);
  a.stepFrames(150); b.stepFrames(150);
  assert.strictEqual(b.hash(), a.hash(), "they still match after running on");
  assert.strictEqual(a.diskFlush(0), 0);
  assert.strictEqual(b.diskFlush(0), 0);
  assert.ok(a.readFloppy(0).equals(b.readFloppy(0)), "the floppy matches too");
});

test("color mode: boots at 320x200 with several colors", async function () {
  const cfg = require("./harness.js").DEFAULT_CFG.replace("mono = 1", "mono = 0");
  const core = await createCore({ cfg: cfg });
  for (let i = 0; i < 2500; i++) { core.stepFrame(); core.takeAudio(); }
  const v = core.video();
  assert.strictEqual(v.width, 320);
  assert.strictEqual(v.height, 200);
  const colors = new Set();
  for (let i = 0; i < v.rgb.length; i += 3) colors.add(v.rgb[i] << 16 | v.rgb[i + 1] << 8 | v.rgb[i + 2]);
  assert.ok(colors.size >= 3, "distinct colors: " + colors.size);
  writePng(path.join(OUT, "color.png"), v.width, v.height, v.rgb);
});

test("PCE messages work (emu.pause is accepted, an unknown message is not)", async function () {
  const core = await createCore();
  assert.strictEqual(core.msg("emu.pause", "0"), 0);
  assert.notStrictEqual(core.msg("no.such.message", "1"), 0);
});

(async function main() {
  const only = process.argv.find(function (a) { return a.indexOf("--only=") === 0; });
  const filter = only ? only.slice(7) : null;
  let failed = 0;
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
  console.log(failed ? failed + " test(s) failed" : "all tests passed");
  process.exit(failed ? 1 : 0);
})();
