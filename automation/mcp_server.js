#!/usr/bin/env node
"use strict";
// MCP server (stdio, JSON-RPC 2.0, one message per line) over the headless PCE_ST
// automation. Tools:
//   get_capabilities   versions, formats and the list of actions of every group
//   get_system_state   the machine summary (clock, registers, floppies, joystick, hash)
//   call_automation    { domain, action, args } -> any action of system, media, input, debug,
//                      artifacts (see AUTOMATION.md)
// Run:  node automation/mcp_server.js [--cwd DIR] [--allow-any-path] [--rom FILE] [--no-boot]
// Paths in arguments are relative to --cwd (default: the current directory) and, unless
// --allow-any-path is given, must stay inside it.

const path = require("path");
const readline = require("readline");
const { createHeadlessAutomation, API_VERSION } = require("./headless");

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";
const DOMAINS = ["system", "media", "input", "debug", "artifacts"];

function protocolError(code, message, data) {
  const err = new Error(message);
  err.code = code; err.data = data; err.isProtocolError = true;
  return err;
}

function isPlain(v) { return !!v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && Object.getPrototypeOf(v) === Object.prototype; }

// Buffers become { byteLength, base64 } so the result is plain JSON.
function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.from(value.buffer ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value);
    return { byteLength: b.length, base64: b.toString("base64") };
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (isPlain(value)) {
    const out = {};
    Object.keys(value).forEach(function (k) { const v = sanitize(value[k]); if (v !== undefined) out[k] = v; });
    return out;
  }
  return value;
}

function text(message) { return [{ type: "text", text: message }]; }

function ok(label, raw, content) {
  return { content: content || text(label + ": ok"), structuredContent: { tool: label, result: sanitize(raw) }, isError: false };
}

function failure(label, err) {
  return {
    content: text(label + ": " + (err && err.message ? err.message : "failed")),
    structuredContent: { tool: label, error: { name: err && err.name || "Error", message: err && err.message || "failed", code: err && err.code } },
    isError: true,
  };
}

const TOOLS = [
  { name: "get_capabilities", title: "Get Capabilities", description: "Automation version, supported formats and the list of actions in every group.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "get_system_state", title: "Get System State", description: "The machine summary: clock, frame, registers, floppies, joystick, state hash.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  {
    name: "call_automation",
    title: "Call PCE_ST Automation",
    description: "Run an action of the PCE_ST automation API: { domain, action, args }. Domains: system (boot, reset, run, getState), media (mountFloppy, buildFloppy, ejectFloppy, readFloppy, listFiles, readFile, flushFloppy), input (key, typeText, mouse, click, moveMouse, joystick, releaseAll), debug (peek, poke, readMemory, writeMemory, getRegisters, getStateHash, runUntilMemory, runUntilStable), artifacts (captureScreenshot, captureAudio, saveSnapshot, loadSnapshot). The machine only advances inside run/step-like actions (run, key tap, typeText, click...).",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        domain: { type: "string", enum: DOMAINS },
        action: { type: "string" },
        args: { type: "object", additionalProperties: true, description: "Arguments of the action. Binary inputs: { path } | { base64 } | { bytes }. Durations: { frames } | { seconds } | { ms } | { cycles } or strings such as \"2s\"." },
      },
      required: ["domain", "action"],
    },
  },
];

const INSTRUCTIONS = [
  "This server drives a deterministic Atari ST emulator (PCE) with no browser.",
  "Call get_capabilities for the action list, then system.boot (EmuTOS is built in) and system.run to let the machine work.",
  "Time only advances through actions that take a duration; use debug.runUntilStable with minDarkPercent 30 to wait for the monochrome desktop.",
  "artifacts.captureScreenshot returns an image block.",
].join(" ");

async function createMcpSession(options) {
  const opts = options || {};
  const auto = await createHeadlessAutomation({ cwd: opts.cwd, confinePaths: opts.confinePaths !== false });
  const api = auto.api;
  let initialized = false;

  if (opts.boot !== false) await api.system.boot(opts.rom ? { rom: { path: opts.rom } } : {});

  async function callTool(name, args) {
    try {
      if (name === "get_capabilities") return ok(name, api.system.getCapabilities());
      if (name === "get_system_state") return ok(name, api.system.getState());
      if (name !== "call_automation") throw protocolError(-32601, "Unknown tool: " + name);
      const a = isPlain(args) ? args : {};
      if (!a.domain || !a.action) throw protocolError(-32602, "call_automation requires domain and action");
      if (DOMAINS.indexOf(a.domain) < 0) throw protocolError(-32602, "Unknown domain: " + a.domain, { domains: DOMAINS });
      const group = api[a.domain];
      if (!Object.prototype.hasOwnProperty.call(group, a.action) || typeof group[a.action] !== "function") {
        throw protocolError(-32602, "Unknown " + a.domain + " action: " + a.action, { actions: Object.keys(group) });
      }
      const raw = await group[a.action](isPlain(a.args) ? a.args : {});
      const label = a.domain + "." + a.action;
      if (label === "artifacts.captureScreenshot" && raw && raw.png) {
        return ok(label, raw, [{ type: "image", data: Buffer.from(raw.png).toString("base64"), mimeType: "image/png" },
          { type: "text", text: label + ": " + raw.width + "x" + raw.height + ", dark " + raw.darkPixelPercent + "%" }]);
      }
      return ok(label, raw);
    } catch (err) {
      if (err && err.isProtocolError) throw err;
      return failure(name === "call_automation" && args && args.action ? args.domain + "." + args.action : name, err);
    }
  }

  async function handle(message) {
    if (!isPlain(message)) throw protocolError(-32600, "Invalid request");
    const id = message.id;
    switch (message.method) {
      case "initialize": {
        const requested = message.params && message.params.protocolVersion ? String(message.params.protocolVersion) : "";
        if (PROTOCOLS.indexOf(requested) < 0) throw protocolError(-32602, "Unsupported protocol version", { supported: PROTOCOLS, requested: requested || null });
        initialized = true;
        return { jsonrpc: "2.0", id: id, result: { protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "PCE_ST MCP", version: VERSION }, instructions: INSTRUCTIONS } };
      }
      case "initialized": case "notifications/initialized": return null;
      case "ping": return { jsonrpc: "2.0", id: id, result: {} };
      case "shutdown": auto.dispose(); return { jsonrpc: "2.0", id: id, result: {} };
      default:
    }
    if (!initialized) throw protocolError(-32002, "Server not initialized");
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: id, result: { tools: TOOLS } };
    if (message.method === "tools/call") {
      const params = isPlain(message.params) ? message.params : {};
      if (!params.name) throw protocolError(-32602, "tools/call requires a tool name");
      return { jsonrpc: "2.0", id: id, result: await callTool(String(params.name), params.arguments) };
    }
    throw protocolError(-32601, "Unknown method: " + String(message.method));
  }

  // One JSON-RPC message (or a batch) -> response(s), serialized so the machine is never
  // driven by two calls at once.
  let queue = Promise.resolve();
  function handlePayload(payload) {
    const run = queue.then(async function () {
      if (Array.isArray(payload)) {
        const out = [];
        for (const item of payload) { const r = await one(item); if (r) out.push(r); }
        return out;
      }
      return one(payload);
    });
    queue = run.catch(function () { /* keep the queue alive */ });
    return run;
  }
  async function one(payload) {
    const isRequest = isPlain(payload) && Object.prototype.hasOwnProperty.call(payload, "id");
    try {
      return await handle(payload);
    } catch (err) {
      if (!isRequest) return null;
      if (err && err.isProtocolError) return { jsonrpc: "2.0", id: payload.id, error: { code: err.code, message: err.message, data: sanitize(err.data) } };
      return { jsonrpc: "2.0", id: payload.id, error: { code: -32603, message: err && err.message || "Internal error" } };
    }
  }

  return { tools: TOOLS, handlePayload: handlePayload, api: api, dispose: function () { auto.dispose(); } };
}

function parseArgs(argv) {
  const args = { cwd: process.cwd(), confinePaths: true, boot: true, rom: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--cwd" && i + 1 < argv.length) args.cwd = path.resolve(argv[++i]);
    else if (t === "--rom" && i + 1 < argv.length) args.rom = path.resolve(argv[++i]);
    else if (t === "--allow-any-path") args.confinePaths = false;
    else if (t === "--no-boot") args.boot = false;
    else if (t === "--help") { process.stdout.write("Usage: node automation/mcp_server.js [--cwd DIR] [--rom FILE] [--allow-any-path] [--no-boot]\n"); process.exit(0); }
  }
  return args;
}

async function main() {
  const session = await createMcpSession(parseArgs(process.argv));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", function (line) {
    if (!line.trim()) return;
    let payload;
    try { payload = JSON.parse(line); }
    catch (err) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
    session.handlePayload(payload).then(function (response) {
      if (response !== null && response !== undefined && !(Array.isArray(response) && !response.length)) process.stdout.write(JSON.stringify(response) + "\n");
    });
  });
  rl.on("close", function () { session.dispose(); process.exit(0); });
}

if (require.main === module) {
  main().catch(function (err) { process.stderr.write("PCE_ST MCP: " + (err && err.stack || err) + "\n"); process.exit(1); });
}

module.exports = { createMcpSession };
