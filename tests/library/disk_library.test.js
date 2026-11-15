/* global __dirname, console, process, require, setTimeout, clearTimeout */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadApi() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "js", "core", "disk_library.js"),
    "utf8",
  );
  const context = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    Uint8Array: Uint8Array,
    ArrayBuffer: ArrayBuffer,
    Date: Date,
    Math: Math,
    Object: Object,
    String: String,
    Number: Number,
    Boolean: Boolean,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Map: Map,
    Set: Set,
    Error: Error,
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  ["library_archive.js", "library_package.js", "st_image.js", "disk_library.js"].forEach(function (file) {
    const fileSource = file === "disk_library.js"
      ? source
      : fs.readFileSync(path.join(__dirname, "..", "..", "web", "js", "core", file), "utf8");
    vm.runInContext(fileSource, context, { filename: file });
  });
  const api = context.window.PCE_STDiskLibrary.createApi();
  api.window = context.window;
  return api;
}

async function main() {
  const mounted = new Map();
  const unmounted = [];
  let nextImageIndex = 0;
  const api = loadApi();
  const window = api.window;
  const library = api.create({
    mountDisk: function (bytes, name, slot) {
      const imageIndex = nextImageIndex++;
      mounted.set(slot, { imageIndex: imageIndex, bytes: new Uint8Array(bytes), name: name });
      return { imageIndex: imageIndex, deviceSlot: slot };
    },
    unmountDisk: function (slot) {
      unmounted.push(slot);
      mounted.delete(slot);
    },
    getDiskImageBytes: function (imageIndex) {
      for (const item of mounted.values()) {
        if (item.imageIndex === imageIndex) return item.bytes;
      }
      return null;
    },
  });

  await library.init();
  assert.equal(library.isReady(), true);
  const storage = await library.getStorageEstimate();
  assert.equal(storage.supported, false);
  assert.equal(library.isRestored(), false);
  await library.restoreMounts();
  assert.equal(library.isRestored(), true);
  const floppy = await library.addFile("GAME.ST", new Uint8Array([1, 2, 3]));
  assert.equal(floppy.name, "GAME.ST");
  assert.equal(library.listFiles()[0].mountedSlot, -1);
  const invalidReport = await library.verifyFile(floppy.id);
  assert.equal(invalidReport.valid, false);

  await library.mountFile(floppy.id, 0);
  assert.equal(library.listFiles()[0].mountedSlot, 0);
  const firstMount = mounted.get(0);
  firstMount.bytes[1] = 9;
  await library.onDiskMediaChanged(firstMount.imageIndex);

  const downloaded = await library.downloadFile(floppy.id);
  assert.equal(downloaded.name, "GAME.ST");
  assert.deepEqual(Array.from(new Uint8Array(downloaded.buffer)), [1, 9, 3]);
  assert.equal(library.listFiles()[0].dirty, false);
  const changedHistory = await library.exportPackage({ fileName: "history.pcest" });
  const changedManifest = await library.inspectPackage(changedHistory.buffer);
  assert.ok(changedManifest.manifest.library[0].revisions.length >= 2);
  const revisions = library.listRevisions(floppy.id);
  assert.ok(revisions.length >= 2);
  await library.selectRevision(floppy.id, revisions[0].id);
  const restoredRevision = await library.downloadFile(floppy.id);
  assert.deepEqual(Array.from(new Uint8Array(restoredRevision.buffer)), [1, 2, 3]);

  const second = await library.addFile("SECOND.ST", new Uint8Array([4]));
  await library.mountFile(second.id, 0);
  const files = library.listFiles();
  assert.equal(files.find(function (file) { return file.id === floppy.id; }).mountedSlot, -1);
  assert.equal(files.find(function (file) { return file.id === second.id; }).mountedSlot, 0);
  assert.deepEqual(unmounted, [0]);

  const exported = await library.exportPackage({
    libraryVersion: 3,
    createdAt: "2026-10-08T15:00:00Z",
  });
  assert.ok(exported.buffer && exported.buffer.byteLength > 0);
  const inspected = await library.inspectPackage(exported.buffer);
  assert.equal(inspected.manifest.schemaVersion, 1);
  assert.equal(inspected.manifest.libraryVersion, 3);
  assert.equal(inspected.manifest.library.length, 2);
  assert.equal(inspected.manifest.workspace.devices.A, second.id);
  const workspaceExport = await library.exportWorkspacePackage();
  const workspacePackage = await library.inspectPackage(workspaceExport.buffer);
  assert.equal(workspacePackage.manifest.scope, "workspace");
  assert.equal(workspacePackage.manifest.library.length, 1);
  assert.equal(workspacePackage.manifest.library[0].id, second.id);
  assert.equal(workspacePackage.manifest.workspace.devices.A, second.id);

  await library.deleteFile(second.id);
  assert.equal(library.listFiles().length, 1);
  assert.equal(library.listTrash().length, 1);
  assert.equal(library.listTrash()[0].id, second.id);
  await library.restoreTrash(second.id);
  assert.equal(library.listFiles().length, 2);
  await library.deleteFile(second.id);
  await library.purgeTrash(second.id);
  assert.equal(library.listTrash().length, 0);
  const imported = await library.importPackage(exported.buffer);
  assert.equal(imported.summary.added, 1);
  assert.equal(imported.summary.duplicates, 1);
  assert.equal(imported.restoredMounts.length, 1);
  assert.equal(library.listFiles().length, 2);
  await assert.rejects(library.importPackage(new Uint8Array([1, 2, 3])), /Invalid PCE_ST ZIP archive/);
  assert.equal(library.listFiles().length, 2);
  const folder = await library.createFolder("Projects");
  const folderFile = await library.addFile("FOLDER.ST", new Uint8Array([5]), folder.id);
  const rootSameName = await library.addFile("FOLDER.ST", new Uint8Array([6]), "root");
  assert.equal(rootSameName.name, "FOLDER.ST");
  const blank = await library.createBlankFloppy("EMPTY.ST", folder.id);
  assert.equal(blank.format, "st");
  assert.equal(blank.size, 720 * 1024);
  const blankDownload = await library.downloadFile(blank.id);
  const blankBytes = new Uint8Array(blankDownload.buffer);
  assert.equal(blankBytes[0], 0xe9);
  assert.equal(blankBytes[510], 0);
  assert.equal(blankBytes[11] | (blankBytes[12] << 8), 512);
  const blankReport = await library.verifyFile(blank.id);
  assert.equal(blankReport.valid, true);
  assert.equal(blankReport.filesystemKnown, true);
  assert.equal(library.listFiles(folder.id).length, 2);
  assert.ok(library.listFiles(folder.id).some(function (file) { return file.id === folderFile.id; }));
  assert.ok(library.listFiles(folder.id).some(function (file) { return file.id === blank.id; }));
  await library.deleteFile(rootSameName.id);
  await library.moveFile(folderFile.id, "root");
  assert.equal(library.listFiles(folder.id).length, 1);
  await library.deleteFile(blank.id);
  assert.equal(library.listFiles(folder.id).length, 0);
  const purgedOld = await library.purgeTrashBefore(Date.now() + 1);
  assert.equal(purgedOld, 2);
  assert.equal(library.listTrash().length, 0);
  await library.deleteFolder(folder.id);

  // Guest changes not yet reported are pulled from the machine when the entry is unmounted.
  const pullEntry = await library.addFile("PULL.ST", new Uint8Array([1, 1, 1]));
  await library.mountFile(pullEntry.id, 0);
  mounted.get(0).bytes[2] = 7;
  await library.unmountFile(pullEntry.id);
  const pulled = await library.downloadFile(pullEntry.id);
  assert.deepEqual(Array.from(new Uint8Array(pulled.buffer)), [1, 1, 7]);
  assert.ok(library.listRevisions(pullEntry.id).length >= 2, "the change became a revision");

  // A loose program is wrapped in a generated floppy and mounted in B:.
  const program = new Uint8Array([0x60, 0x1a, 1, 2, 3, 4]);
  const prg = await library.addFile("TOOL.PRG", program);
  assert.equal(prg.format, "prg");
  const prgMounted = await library.mountFile(prg.id, 1);
  assert.equal(prgMounted.converted, true);
  assert.equal(prgMounted.mountedSlot, 1);
  const wrapped = mounted.get(1);
  assert.equal(wrapped.name, "TOOL.ST");
  const wrappedReport = window.PCE_STImage.verify(wrapped.bytes);
  assert.equal(wrappedReport.valid, true);
  assert.equal(wrappedReport.files.map(function (f) { return f.path; }).join(","), "TOOL.PRG");
  const prgDownload = await library.downloadFile(prg.id);
  assert.equal(prgDownload.name, "TOOL.ST");
  assert.equal(prgDownload.originalName, "TOOL.PRG");
  assert.equal(prgDownload.converted, true);
  console.log("disk_library.test.js passed");
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
