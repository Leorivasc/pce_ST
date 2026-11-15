/* global console, process, require */

// A loose PRG keeps its original bytes as a revision while the entry is
// exported as the generated floppy (.st). The blob the first browser uploaded as `<sha>.prg` is
// then referenced as `<sha>.st`; a third browser must still be able to pull it.
const assert = require("node:assert/strict");
const { loadContext, startServer, makeBrowser } = require("./remote_test_support.js");

function prg(seed) {
  const bytes = new Uint8Array(40);
  bytes.set([0xff, 0xff, 0x00, 0x06, 0x1f, 0x06]);
  for (let i = 6; i < bytes.length; i++) bytes[i] = (seed * 17 + i) & 255;
  return bytes;
}

async function main() {
  const context = loadContext();
  const api = context.window.PCE_STRemoteWorkspace;
  const remote = await startServer();
  try {
    const client = api.createClient({ url: remote.url, user: "leo", password: "secret" });
    await client.connect();
    const makeSync = function (library) {
      return context.window.PCE_STRemoteLibrary.createSync({ client: client, library: library, state: {} });
    };
    const first = await makeBrowser(context);
    const second = await makeBrowser(context);
    const third = await makeBrowser(context);
    const syncFirst = makeSync(first);
    await syncFirst.prepare();

    // The first browser adds a plain PRG and publishes it as blobs/<sha>.prg.
    await first.addFile("BENCH.PRG", prg(1));
    await syncFirst.sync();
    assert.ok(Array.from(remote.files.keys()).some(function (name) { return name.endsWith(".prg"); }));

    // The second browser pulls it, runs it (converting it to an floppy) and syncs.
    const syncSecond = makeSync(second);
    await syncSecond.sync();
    const entry = second.listAllFiles()[0];
    await second.mountFile(entry.id, 0);
    await syncSecond.sync();

    // A third browser must be able to pull everything the manifest references.
    const report = await makeSync(third).sync();
    assert.equal(report.pulled, true);
    assert.equal(third.listAllFiles().length, 1);
    // The remote still holds the blob under its original .prg name only.
    const manifest = JSON.parse(remote.files.get("library.json").body.toString());
    const named = manifest.library[0].revisions.map(function (revision) { return revision.path; });
    assert.ok(named.some(function (name) { return name.endsWith(".st") && !remote.files.has(name); }),
      "the manifest names an .st blob the remote only stores as .prg");
    console.log("remote_library_prg_blobs.test.js passed");
  } finally {
    remote.server.close();
  }
  process.exit(0);
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
