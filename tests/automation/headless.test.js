/* global __dirname, console, process, require */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHeadlessAutomation } = require(path.join(__dirname, "..", "..", "automation", "headless.js"));
const { makeBlankST } = require("../core/stimage.js");
const { stFromToStx } = require("../core/stximage.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

async function desktop() {
  const auto = await createHeadlessAutomation();
  await auto.api.system.boot();
  const r = auto.api.debug.runUntilStable({ stableFrames: 60, maxFrames: 4000, minDarkPercent: 30 });
  assert.equal(r.stable, true, "the desktop is drawn");
  return auto.api;
}

test("boot is deterministic and reports the machine state", async function () {
  assert.equal((await createHeadlessAutomation()).api.system.getState().booted, false);
  const a = await createHeadlessAutomation(), b = await createHeadlessAutomation();
  await a.api.system.boot(); await b.api.system.boot();
  a.api.system.run({ frames: 300 }); b.api.system.run({ frames: 300 });
  const sa = a.api.system.getState(), sb = b.api.system.getState();
  assert.equal(sa.hash, sb.hash, "two runs end in the same state");
  assert.equal(sa.config.mono, true);
  assert.equal(sa.rom, "EmuTOS");
  assert.ok(sa.seconds > 4, "300 mono frames are about 4.2 s");
  assert.ok(sa.registers.pc > 0);
  assert.deepEqual(Object.keys(sa.floppies), ["A", "B"]);
});

test("durations: frames, seconds, ms and strings advance emulated time", async function () {
  const a = (await createHeadlessAutomation()).api;
  await a.system.boot();
  const c0 = a.system.getState().clock;
  a.system.run({ seconds: 0.5 });
  const c1 = a.system.getState().clock;
  assert.equal(c1 - c0, 4000000);
  a.system.run("100ms");
  assert.equal(a.system.getState().clock - c1, 800000);
  assert.throws(function () { a.system.run("soon"); }, /Bad duration/);
});

test("the screenshot is a PNG and the desktop has the expected darkness", async function () {
  const api = await desktop();
  const shot = api.artifacts.captureScreenshot();
  assert.equal(shot.width, 640);
  assert.equal(shot.height, 400);
  assert.ok(shot.darkPixelPercent > 40 && shot.darkPixelPercent < 60, "dotted desktop: " + shot.darkPixelPercent);
  assert.deepEqual(Array.from(shot.png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("a floppy is mounted, listed and read back; a PRG is wrapped; an MSA converts", async function () {
  const api = await desktop();
  const img = makeBlankST("AUTOTEST", [{ name: "HELLO.TXT", data: "hello automation" }]);
  const m = api.media.mountFloppy({ drive: "A", base64: img.toString("base64"), name: "t.st" });
  assert.equal(m.floppy.name, "t.st");
  const list = api.media.listFiles({ drive: "A" });
  assert.equal(list.label, "AUTOTEST");
  assert.deepEqual(list.entries.map(function (e) { return e.name; }), ["HELLO.TXT"]);
  assert.equal(api.media.readFile({ drive: "A", path: "hello.txt", asText: true }).text, "hello automation");
  api.media.mountFloppy({ drive: "B", bytes: [0x60, 0x1a, 0, 0], name: "tool.prg" });
  assert.equal(api.system.getState().floppies.B.name, "tool.st");
  assert.deepEqual(api.media.listFiles({ drive: "B" }).entries.map(function (e) { return e.name; }), ["TOOL.PRG"]);
  const built = api.media.buildFloppy({ label: "WORK", drive: "B", files: [{ name: "a.prg", bytes: [1, 2, 3] }, { name: "b.txt", base64: Buffer.from("B").toString("base64") }] });
  assert.equal(built.floppy.size, 720 * 1024);
  assert.deepEqual(api.media.listFiles({ drive: "B" }).entries.map(function (e) { return e.name; }), ["A.PRG", "B.TXT"]);
  assert.throws(function () { api.media.listFiles({ drive: "C" }); }, /Drive must be A or B/);
  api.media.ejectFloppy({ drive: "A" });
  assert.throws(function () { api.media.readFloppy({ drive: "A" }); }, /No floppy/);
});

test("input: the guest creates a folder on the floppy and the change comes back", async function () {
  const api = await desktop();
  api.media.mountFloppy({ drive: "A", base64: makeBlankST("GUEST", [{ name: "HELLO.TXT", data: "x" }]).toString("base64"), name: "g.st" });
  api.system.run({ frames: 20 });
  api.input.moveMouse({ dx: -300, dy: -170 });
  api.input.moveMouse({ dx: 15, dy: 6 });
  api.input.click({ double: true });
  api.system.run({ frames: 200 });
  api.input.key({ key: "ControlLeft", action: "press" });
  api.system.run({ frames: 3 });
  api.input.key({ key: "KeyN" });
  api.input.key({ key: "ControlLeft", action: "release" });
  api.system.run({ frames: 60 });
  api.input.typeText({ text: "x\n" });
  api.system.run({ frames: 1200 });
  assert.equal(api.system.getState().floppies.A.modified, true, "the guest wrote");
  api.media.flushFloppy({ drive: "A" });
  const names = api.media.listFiles({ drive: "A" }).entries.map(function (e) { return e.name; }).sort();
  assert.deepEqual(names, ["HELLO.TXT", "X"]);
});

test("a Pasti .stx floppy is read-only: the original image comes back even after the guest writes", async function () {
  const api = await desktop();
  const stx = stFromToStx(makeBlankST("PASTI", [{ name: "HELLO.TXT", data: "x" }]));
  const m = api.media.mountFloppy({ drive: "A", base64: stx.toString("base64"), name: "game.stx" });
  assert.equal(m.floppy.name, "game.stx");
  assert.equal(m.floppy.readOnly, true);
  assert.ok(api.system.getCapabilities().formats.includes("stx"));
  api.system.run({ frames: 20 });
  api.input.moveMouse({ dx: -300, dy: -170 });
  api.input.moveMouse({ dx: 15, dy: 6 });
  api.input.click({ double: true });
  api.system.run({ frames: 200 });
  api.input.key({ key: "ControlLeft", action: "press" });
  api.system.run({ frames: 3 });
  api.input.key({ key: "KeyN" });
  api.input.key({ key: "ControlLeft", action: "release" });
  api.system.run({ frames: 60 });
  api.input.typeText({ text: "x\n" });
  api.system.run({ frames: 1200 });
  assert.equal(api.system.getState().floppies.A.modified, false, "a .stx never reports unsaved changes");
  api.media.flushFloppy({ drive: "A" });
  const back = api.media.readFloppy({ drive: "A" });
  assert.equal(back.size, stx.length, "the image is not truncated");
  assert.equal(back.sha256, require("node:crypto").createHash("sha256").update(stx).digest("hex"), "the original bytes come back");
  assert.throws(function () { api.media.listFiles({ drive: "A" }); }, /Pasti/);
  assert.throws(function () { api.media.mountFloppy({ drive: "B", bytes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], name: "bad.stx" }); }, /Pasti/);
});

// Opens the A: window twice (double click on the icon, twice) and returns a hash of its region.
function openAndHash(api) {
  api.system.run({ frames: 20 });
  api.input.moveMouse({ dx: -300, dy: -170 });
  api.input.moveMouse({ dx: 15, dy: 6 });
  api.input.click({ double: true });
  api.system.run({ frames: 200 });
  return api;
}

function windowHash(api) {
  const shot = api.artifacts.captureScreenshot();
  return require("node:crypto").createHash("sha256").update(shot.png).digest("hex");
}

test("swapping a floppy makes TOS show the new disk (also with identical serial numbers)", async function () {
  const one = makeBlankST("ONE", [{ name: "ONLYONE.TXT", data: "1" }]);
  const two = makeBlankST("TWO", [{ name: "ONLYTWO.TXT", data: "2" }]);
  // Reference: a machine that only ever had the second disk.
  const ref = await desktop();
  ref.media.mountFloppy({ drive: "A", bytes: two, name: "two.st" });
  openAndHash(ref);
  ref.input.click({ double: true }); ref.system.run({ frames: 200 });
  // The same flow, but the first disk was mounted (and browsed) before the swap.
  const api = await desktop();
  api.media.mountFloppy({ drive: "A", bytes: one, name: "one.st" });
  openAndHash(api);
  const before = windowHash(api);
  api.media.mountFloppy({ drive: "A", bytes: two, name: "two.st" });   // swap
  api.system.run({ seconds: 2 });
  api.input.click({ double: true }); api.system.run({ frames: 200 });
  assert.notEqual(windowHash(api), before, "the window changed");
  // The desktop is pixel-identical to the machine that only ever had the second disk.
  assert.equal(windowHash(api), windowHash(ref), "the swapped machine shows the second disk's files");
  // Eject then mount some time later works too, and the file system shows the right files.
  api.media.ejectFloppy({ drive: "A" });
  api.system.run({ seconds: 1 });
  api.media.mountFloppy({ drive: "A", bytes: one, name: "one.st" });
  assert.deepEqual(api.media.listFiles({ drive: "A" }).entries.map(function (e) { return e.name; }), ["ONLYONE.TXT"]);
  // The core reports the swap in the emulated clock: the gap was run, not skipped.
  const c0 = api.system.getState().clock;
  api.media.mountFloppy({ drive: "A", bytes: two, name: "two.st" });
  assert.ok(api.system.getState().clock - c0 >= 4000000, "half a second of emulated time passes during a swap");
});

test("both drives reach the guest: A: and B: each show their own disk, whatever the mount order", async function () {
  const one = makeBlankST("ONE", [{ name: "ONLYONE.TXT", data: "1" }]);
  const two = makeBlankST("TWO", [{ name: "ONLYTWO.TXT", data: "2" }]);
  async function screen(first, second) {
    const api = await desktop();
    api.media.mountFloppy({ drive: first[0], bytes: first[1], name: "x.st" });
    api.media.mountFloppy({ drive: second[0], bytes: second[1], name: "y.st" });
    openAndHash(api);                                  // opens A:
    api.input.moveMouse({ dx: 90, dy: 0 });
    api.input.click({ double: true });                 // opens B:
    api.system.run({ frames: 200 });
    return windowHash(api);
  }
  const ab = await screen(["A", one], ["B", two]);
  const ba = await screen(["B", two], ["A", one]);
  const same = await screen(["A", one], ["B", one]);
  assert.equal(ab, ba, "mounting B: first and A: second gives the same desktop");
  assert.notEqual(ab, same, "B: shows its own disk, not A:'s");
});

test("saving a floppy while TOS is copying onto it does not disturb the transfer", async function () {
  // The library saves a floppy as soon as the guest changes it, so a save can land in the
  // middle of a transfer. The controller's track buffer must not be thrown away then.
  const { createFloppy } = require("../../web/js/core/st_image.js");
  const api = (await createHeadlessAutomation()).api;
  await api.system.boot();
  api.debug.runUntilStable({ stableFrames: 60, maxFrames: 4000, minDarkPercent: 30 });
  api.media.mountFloppy({ drive: "A", bytes: makeBlankST("SRC", [{ name: "STRAID.PRG", data: Buffer.alloc(223056, 9) }]), name: "src.st" });
  api.media.mountFloppy({ drive: "B", bytes: Buffer.from(createFloppy({ label: "PCE_ST" })), name: "dst.st" });
  api.system.run({ frames: 20 });
  api.input.moveMouse({ dx: -300, dy: -170 }); api.input.moveMouse({ dx: 15, dy: 6 });
  api.input.click({ double: true }); api.system.run({ frames: 200 });
  // Drag STRAID.PRG from the A: window onto the B: icon.
  api.input.moveMouse({ dx: 30, dy: 120 });
  api.input.mouse({ dx: 0, dy: 0, buttons: 1, after: { frames: 5 } });
  for (let i = 0; i < 12; i++) api.input.mouse({ dx: 5, dy: -10, buttons: 1, after: { frames: 3 } });
  api.system.run({ frames: 5 });
  api.input.mouse({ dx: 0, dy: 0, buttons: 0 }); api.system.run({ frames: 120 });
  api.input.key({ key: "Enter" });
  for (let i = 0; i < 600; i++) {
    api.system.run({ frames: 5 });
    api.media.flushFloppy({ drive: "A" }); api.media.flushFloppy({ drive: "B" });
  }
  const entries = api.media.listFiles({ drive: "B" }).entries;
  assert.deepEqual(entries.map(function (e) { return e.name + ":" + e.size; }), ["STRAID.PRG:223056"]);
});

test("input: typed characters reach the keyboard, the joystick reaches the IKBD", async function () {
  const api = await desktop();
  api.input.typeText({ text: "Hi" });          // needs Shift for H
  assert.throws(function () { api.input.typeText({ text: "é" }); }, /Cannot type/);
  api.input.joystick({ left: true, fire: true });
  assert.equal(api.system.getState().joystick.port1 & 0x84, 0x84);
  api.input.joystick({ left: false, fire: false });
  assert.equal(api.system.getState().joystick.port1 & 0x84, 0);
  assert.throws(function () { api.input.key({ key: "Nonexistent" }); }, /Unknown key/);
  assert.deepEqual(api.input.releaseAll(), { ok: true });
});

test("debug: memory, registers, run-until and audio", async function () {
  const api = await desktop();
  api.debug.writeMemory({ address: 0x20000, bytes: [1, 2, 3, 4] });
  assert.deepEqual(Array.from(api.debug.readMemory({ address: 0x20000, length: 4 }).bytes), [1, 2, 3, 4]);
  assert.equal(api.debug.peek({ address: 0x20002 }).value, 3);
  assert.equal(api.debug.runUntilMemory({ address: 0x20000, value: 1, maxFrames: 5 }).matched, true);
  assert.equal(api.debug.runUntilMemory({ address: 0x20001, value: 99, maxFrames: 3 }).matched, false);
  assert.ok(api.debug.getRegisters().pc > 0);
  const silent = api.artifacts.captureAudio({ seconds: 0.2 });
  assert.equal(silent.peak, 0);
  assert.equal(silent.rate, 48000);
  assert.deepEqual(Array.from(silent.wav.subarray(0, 4)), [0x52, 0x49, 0x46, 0x46]);
  // A tone: channel A at ~440 Hz through the PSG registers.
  [[0, 0xfe], [1, 0x01], [7, 0x3e], [8, 0x0f]].forEach(function (r) {
    api.debug.poke({ address: 0xff8800, value: r[0] }); api.debug.poke({ address: 0xff8802, value: r[1] });
  });
  assert.ok(api.artifacts.captureAudio({ seconds: 0.2 }).peak > 1000, "the PSG tone is captured");
});

test("snapshots round-trip, restore the machine and match the browser's format", async function () {
  const api = await desktop();
  api.debug.writeMemory({ address: 0x20000, bytes: [7, 7, 7, 7] });
  const snap = await api.artifacts.saveSnapshot();
  const hash = api.debug.getStateHash().hash;
  api.debug.writeMemory({ address: 0x20000, bytes: [0, 0, 0, 0] });
  api.system.run({ frames: 30 });
  await api.artifacts.loadSnapshot({ bytes: snap.bytes });
  assert.equal(api.debug.getStateHash().hash, hash, "the state is exactly the saved one");
  assert.deepEqual(Array.from(api.debug.readMemory({ address: 0x20000, length: 4 }).bytes), [7, 7, 7, 7]);
  const codec = require("../../web/js/core/snapshot_codec.js");
  assert.equal(codec.readMeta(new Uint8Array(snap.bytes)).meta.romLabel, "EmuTOS");
});

test("errors are explained: not booted, bad ROM", async function () {
  const api = (await createHeadlessAutomation()).api;
  assert.throws(function () { api.system.run({ frames: 1 }); }, /not booted/);
  assert.throws(function () { api.debug.peek({ address: 0 }); }, /not booted/);
  await assert.rejects(api.system.boot({ rom: { bytes: [1, 2, 3] } }), /192K/);
});

(async function main() {
  const only = process.argv.find(function (a) { return a.indexOf("--only=") === 0; });
  let failed = 0;
  for (const t of tests) {
    if (only && t.name.indexOf(only.slice(7)) < 0) continue;
    const t0 = Date.now();
    try { await t.fn(); console.log("ok   - " + t.name + " (" + (Date.now() - t0) + " ms)"); }
    catch (err) { failed++; console.log("FAIL - " + t.name + "\n       " + (err && err.stack ? err.stack : err)); }
  }
  console.log(failed ? failed + " test(s) failed" : "all tests passed");
  process.exit(failed ? 1 : 0);
})();
