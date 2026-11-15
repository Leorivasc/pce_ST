/* global __dirname, console */
const assert = require("node:assert/strict");
const path = require("node:path");
const codec = require(path.join(__dirname, "..", "..", "web", "js", "core", "snapshot_codec.js"));

(async function () {
  const memory = new Uint8Array(1 << 20).map(function (_, i) { return (i * 7) & 0xff && i % 5 === 0 ? i & 0xff : 0; });
  const floppy = new Uint8Array(1000).map(function (_, i) { return i & 255; });
  const snapshot = { config: { model: "st", mono: true, ramKB: 1024 }, romLabel: "EmuTOS", memory: memory,
    floppies: [{ name: "a.st", bytes: floppy }, null] };
  const file = await codec.encode(snapshot);
  assert.ok(file.length < memory.length / 2, "the memory is compressed (" + file.length + ")");
  const result = await codec.decode(file);
  assert.equal(result.meta.romLabel, "EmuTOS");
  assert.equal(result.snapshot.config.ramKB, 1024);
  assert.deepEqual(Array.from(result.snapshot.memory.subarray(0, 4096)), Array.from(memory.subarray(0, 4096)));
  assert.equal(result.snapshot.memory.length, memory.length);
  assert.equal(result.snapshot.floppies[0].name, "a.st");
  assert.deepEqual(Array.from(result.snapshot.floppies[0].bytes), Array.from(floppy));
  assert.equal(result.snapshot.floppies[1], null);
  assert.equal(codec.readMeta(file).meta.memorySize, memory.length);
  // Damaged files are refused with a message, not a crash.
  await assert.rejects(codec.decode(new Uint8Array([1, 2, 3])), /Not a PCE_ST snapshot/);
  const wrongVersion = new Uint8Array(file); wrongVersion[8] = 9;
  await assert.rejects(codec.decode(wrongVersion), /Unsupported snapshot version/);
  await assert.rejects(codec.decode(file.subarray(0, file.length - 500)), /truncated|corrupt/i);
  const badMeta = new Uint8Array(file); badMeta[14] = 0xff;
  await assert.rejects(codec.decode(badMeta), /not valid/);
  console.log("snapshot_codec.test.js passed");
})().catch(function (err) { console.error(err); process.exit(1); });
