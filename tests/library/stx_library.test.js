/* global __dirname, console, process, require, setTimeout, clearTimeout */
// Pasti (.stx) images in the disk library: stored and mounted as they are, never converted,
// and the machine's (unchanged) bytes never create a revision.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeBlankST } = require("../core/stimage.js");
const { stFromToStx } = require("../core/stximage.js");

function loadApi() {
  const context = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, Date: Date, Math: Math, Object: Object,
    String: String, Number: Number, Boolean: Boolean, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    Map: Map, Set: Set, Error: Error,
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  ["library_archive.js", "library_package.js", "st_image.js", "disk_library.js"].forEach(function (file) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "js", "core", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  });
  return context.window.PCE_STDiskLibrary.createApi();
}

async function main() {
  const stx = new Uint8Array(stFromToStx(makeBlankST("PASTI", [{ name: "HELLO.TXT", data: "x" }])));
  const mounted = new Map();
  const library = loadApi().create({
    mountDisk: function (bytes, name, slot) {
      mounted.set(slot, { imageIndex: slot, bytes: new Uint8Array(bytes), name: name });
      return { imageIndex: slot, deviceSlot: slot };
    },
    unmountDisk: function (slot) { mounted.delete(slot); },
    // What the page does for a .stx: the machine answers with the original bytes.
    getDiskImageBytes: function (index) { return mounted.has(index) ? mounted.get(index).bytes : null; },
  });
  await library.init();

  const info = await library.addFile("GAME.STX", stx);
  assert.equal(info.format, "stx", "the format is kept: a .stx is not converted to .st");
  assert.equal(info.name, "GAME.STX");

  await library.mountFile(info.id, 0);
  assert.equal(mounted.get(0).name, "GAME.STX", "mounted under its own name (PCE picks the format from the extension)");
  assert.deepEqual(Array.from(mounted.get(0).bytes), Array.from(stx), "mounted with exactly the original bytes");

  await library.onDiskMediaChanged(0, 0);
  await library.flush(info.id);
  assert.equal(library.listRevisions(info.id).length, 1, "unchanged bytes from the machine create no revision");

  const download = await library.downloadFile(info.id);
  assert.equal(download.name, "GAME.STX");
  assert.deepEqual(Array.from(new Uint8Array(download.buffer)), Array.from(stx));

  const report = await library.verifyFile(info.id);
  assert.equal(report.skipped, true, "integrity verification only applies to .st images");

  const exported = await library.exportPackage({ fileName: "stx.pcest" });
  const manifest = await library.inspectPackage(exported.buffer);
  assert.equal(manifest.manifest.library[0].type, "stx", "the package records the .stx type");

  // A second library imports the package and gets the same .stx back.
  const other = loadApi().create({ mountDisk: function () { return { imageIndex: 0, deviceSlot: 0 }; }, unmountDisk: function () {} });
  await other.init();
  const imported = await other.importPackage(exported.buffer);
  assert.equal(imported.summary.added, 1);
  const back = await other.downloadFile(other.listFiles()[0].id);
  assert.equal(other.listFiles()[0].format, "stx");
  assert.deepEqual(Array.from(new Uint8Array(back.buffer)), Array.from(stx), "the package round trip keeps the bytes");

  await assert.rejects(library.addFile("GAME.ZIP", stx), /./, "other extensions are still refused");
  console.log("stx_library.test.js passed");
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
