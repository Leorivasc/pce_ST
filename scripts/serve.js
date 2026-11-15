#!/usr/bin/env node
"use strict";
// Development HTTP server, no dependencies.
//
// Usage:  node scripts/serve.js [port]      (default 8080)
// Serves the repository at http://127.0.0.1:<port>/ ; the page is at /web/.
// Requires scripts/build-core.sh to have been run.
//
// The COOP/COEP headers make the page "cross-origin isolated" (needed later for
// SharedArrayBuffer); they change nothing that is used today.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".img": "application/octet-stream",
  ".st": "application/octet-stream",
};

// Only what the page needs is served, not the whole repository.
const ALLOWED = ["/web/", "/core/st_config.js", "/build/out/", "/roms/"];

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
}

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    return send(res, 400, "bad request");
  }
  if (urlPath === "/") {
    res.writeHead(302, { Location: "/web/index.html" });
    return res.end();
  }
  if (!ALLOWED.some(function (p) { return urlPath === p || (p.endsWith("/") && urlPath.startsWith(p)); })) {
    return send(res, 404, "not found");
  }
  const file = path.join(ROOT, urlPath);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, "forbidden");
  fs.readFile(file, function (err, data) {
    if (err) return send(res, 404, "not found: " + urlPath);
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  });
});

// For tests: creates the server and leaves it listening on the port (0 = any free port).
function start(port) {
  return new Promise(function (resolve) {
    server.listen(port, "127.0.0.1", function () { resolve(server); });
  });
}

if (require.main === module) {
  start(PORT).then(function () { console.log("PCE_ST at http://127.0.0.1:" + PORT + "/"); });
}

module.exports = { start: start };
