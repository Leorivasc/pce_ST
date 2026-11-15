/* global __dirname, console, process, require */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "..", "automation", "mcp_server.js");

// Talks to the real server over stdio, like an MCP client would.
function client(args) {
  const child = spawn(process.execPath, [SERVER].concat(args || []), { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const waiting = new Map();
  let nextId = 1;
  child.stdout.on("data", function (chunk) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const c = {
    child: child,
    request: function (method, params) {
      const id = nextId++;
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () { reject(new Error("timeout waiting for " + method)); }, 60000);
        waiting.set(id, function (m) { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n");
      });
    },
    notify: function (method) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: method }) + "\n"); },
    call: function (domain, action, args) { return c.request("tools/call", { name: "call_automation", arguments: { domain: domain, action: action, args: args } }); },
    close: function () { child.stdin.end(); return new Promise(function (r) { child.on("exit", r); }); },
  };
  return c;
}

(async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pce-st-mcp-"));
  const c = client(["--cwd", work]);
  try {
    // Before initialize, calls are refused.
    const early = await c.request("tools/list");
    assert.equal(early.error.code, -32002);
    const bad = await c.request("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(bad.error.code, -32602);
    const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
    assert.equal(init.result.serverInfo.name, "PCE_ST MCP");
    c.notify("notifications/initialized");
    const list = await c.request("tools/list");
    assert.deepEqual(list.result.tools.map(function (t) { return t.name; }), ["get_capabilities", "get_system_state", "call_automation"]);

    const caps = (await c.request("tools/call", { name: "get_capabilities", arguments: {} })).result;
    assert.equal(caps.isError, false);
    assert.ok(caps.structuredContent.result.actions.media.indexOf("mountFloppy") >= 0);

    // The machine is booted by the server; run it to the desktop.
    const wait = (await c.call("debug", "runUntilStable", { stableFrames: 60, maxFrames: 4000, minDarkPercent: 30 })).result;
    assert.equal(wait.structuredContent.result.stable, true);
    const state = (await c.request("tools/call", { name: "get_system_state", arguments: {} })).result.structuredContent.result;
    assert.equal(state.booted, true);
    assert.ok(state.seconds > 5);

    // Screenshot: an image block plus a description; the file goes where asked.
    const shot = (await c.call("artifacts", "captureScreenshot", {})).result;
    assert.equal(shot.content[0].type, "image");
    assert.equal(shot.content[0].mimeType, "image/png");
    assert.equal(Buffer.from(shot.content[0].data, "base64")[1], 0x50);
    const file = (await c.call("artifacts", "captureScreenshot", { out: "shot.png" })).result;
    assert.ok(fs.existsSync(path.join(work, "shot.png")));
    assert.equal(file.structuredContent.result.width, 640);

    // Media by path, results as base64.
    const { makeBlankST } = require("../core/stimage.js");
    fs.writeFileSync(path.join(work, "t.st"), makeBlankST("MCP", [{ name: "A.TXT", data: "from mcp" }]));
    const mount = (await c.call("media", "mountFloppy", { drive: "A", path: "t.st" })).result;
    assert.equal(mount.isError, false);
    const read = (await c.call("media", "readFile", { drive: "A", path: "A.TXT" })).result.structuredContent.result;
    assert.equal(Buffer.from(read.bytes.base64, "base64").toString(), "from mcp");

    // Errors: tool errors carry isError, protocol errors carry codes.
    const missing = (await c.call("media", "readFile", { drive: "A", path: "NOPE.TXT" })).result;
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error.code, "not_found");
    const unknown = await c.call("media", "explode", {});
    assert.equal(unknown.error.code, -32602);
    assert.ok(unknown.error.data.actions.indexOf("mountFloppy") >= 0, "the error lists the valid actions");
    const domain = await c.call("hostfs", "list", {});
    assert.equal(domain.error.code, -32602);

    // Paths cannot leave the working directory.
    const escape = (await c.call("media", "mountFloppy", { drive: "A", path: "../../etc/passwd" })).result;
    assert.equal(escape.isError, true);
    assert.equal(escape.structuredContent.error.code, "path_denied");
    const escapeOut = (await c.call("artifacts", "captureScreenshot", { out: "/tmp/outside.png" })).result;
    assert.equal(escapeOut.structuredContent.error.code, "path_denied");
    fs.symlinkSync("/etc", path.join(work, "link"));
    const viaLink = (await c.call("media", "mountFloppy", { drive: "A", path: "link/hostname" })).result;
    assert.equal(viaLink.structuredContent.error.code, "path_denied", "a symlink does not lead out");

    // Calls queued back to back run one at a time and keep their order.
    const [r1, r2] = await Promise.all([c.call("system", "run", { frames: 5 }), c.call("system", "getState", {})]);
    assert.equal(r1.result.isError, false);
    assert.equal(r2.result.isError, false);
    assert.equal((await c.request("ping")).result && true, true);
  } finally {
    await c.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log("mcp.test.js passed");
})().catch(function (err) { console.error(err); process.exit(1); });
