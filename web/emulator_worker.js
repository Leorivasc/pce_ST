/* global self, importScripts */
// Emulation worker: hosts PCE_STApp and exposes it to the main thread through
// messages (see js/core/app_proxy.js for the other end).
//
// Messages from the main thread:
//   { type: "init", canvas, audioPort, rom, config, crtEnabled, audioEnabled, turbo }
//   { type: "audioPort", port }
//   { type: "cmd", method, args }              fire and forget (input, toggles)
//   { type: "rpc", id, method, args }          request; answered with "rpcResult"
// Messages to the main thread:
//   { type: "ready", state } | { type: "event", event } |
//   { type: "rpcResult", id, ok, result | error } | { type: "fatal", message }
"use strict";

importScripts(
  "../build/out/pce_st_core.js",
  "../core/st_config.js",
  "js/core/keymap.js",
  "js/render/gl.js",
  "js/render/software.js",
  "js/core/st_app.js"
);

let app = null;
let appReady = null;   // resolves when the machine has been created; commands wait for it

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

// Typed arrays found at the top level of a result are transferred, not copied.
function collectTransfers(value, out) {
  if (!value || typeof value !== "object") return;
  if (ArrayBuffer.isView(value)) { out.push(value.buffer); return; }
  if (value instanceof ArrayBuffer) { out.push(value); return; }
  Object.keys(value).forEach(function (k) {
    const v = value[k];
    if (v && typeof v === "object") {
      if (ArrayBuffer.isView(v)) out.push(v.buffer);
      else if (v instanceof ArrayBuffer) out.push(v);
    }
  });
}

function serializeError(err) {
  return { name: err && err.name ? String(err.name) : "Error", message: err && err.message ? String(err.message) : String(err) };
}

function callMethod(method, args) {
  if (!app || typeof app[method] !== "function") throw new Error("Unknown method: " + method);
  return app[method].apply(app, args || []);
}

self.onmessage = async function (ev) {
  const m = ev.data;
  try {
    if (m.type === "init") {
      appReady = (async function () {
        app = await self.PCE_STApp.create({
          canvas: m.canvas,
          audioPort: m.audioPort || null,
          rom: m.rom || null,
          config: m.config,
          crtEnabled: m.crtEnabled,
          audioEnabled: m.audioEnabled,
          turbo: m.turbo,
          onEvent: function (event) { post({ type: "event", event: event }); },
        });
        post({ type: "ready", state: app.getState() });
      })();
      await appReady;
      return;
    }
    // Everything else needs the machine; messages sent during creation wait here.
    if (appReady) await appReady;
    if (m.type === "audioPort") {
      if (app) app.setAudioPort(m.port);
    } else if (m.type === "cmd") {
      callMethod(m.method, m.args);
    } else if (m.type === "rpc") {
      let result;
      try {
        result = await callMethod(m.method, m.args);
      } catch (err) {
        post({ type: "rpcResult", id: m.id, ok: false, error: serializeError(err) });
        return;
      }
      const transfers = [];
      collectTransfers(result, transfers);
      post({ type: "rpcResult", id: m.id, ok: true, result: result }, transfers);
    }
  } catch (err) {
    post({ type: "fatal", message: String(err && err.message ? err.message : err) });
  }
};
