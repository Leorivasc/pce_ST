// Snapshot files: the machine's memory (compressed) and mounted floppies in one
// container.  Layout:  "PCESTSNP" | version u8 | meta length u32 (LE) | meta JSON
// (UTF-8) | memory payload | floppy payloads...   Payload sizes are in the metadata.
(function (root) {
  "use strict";

  const MAGIC = "PCESTSNP";
  const VERSION = 1;
  const MAX_MEMORY = 64 * 1024 * 1024;

  async function pump(bytes, stream) {
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(function () { /* surfaced by the reader */ });
    writer.close().catch(function () { /* surfaced by the reader */ });
    const chunks = [];
    let total = 0;
    const reader = stream.readable.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      total += part.value.length;
      if (total > MAX_MEMORY) throw new Error("The snapshot is too large");
    }
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(function (chunk) { out.set(chunk, offset); offset += chunk.length; });
    return out;
  }

  function hasStreams() { return typeof root.CompressionStream === "function" && typeof root.DecompressionStream === "function"; }

  // snapshot: { config, romLabel, memory, floppies: [{name, bytes}|null, ...] }
  async function encode(snapshot) {
    const compress = hasStreams();
    const memory = compress ? await pump(snapshot.memory, new root.CompressionStream("deflate")) : snapshot.memory;
    const floppies = (snapshot.floppies || []).map(function (f) { return f ? { name: f.name, size: f.bytes.length } : null; });
    const meta = {
      format: "pce-st-snapshot",
      version: VERSION,
      created: Date.now(),
      config: snapshot.config,
      romLabel: snapshot.romLabel || "",
      memorySize: snapshot.memory.length,
      memoryStored: memory.length,
      memoryCompression: compress ? "deflate" : "none",
      floppies: floppies,
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const parts = [new Uint8Array(MAGIC.split("").map(function (c) { return c.charCodeAt(0); })), new Uint8Array([VERSION]),
      new Uint8Array(new Uint32Array([metaBytes.length]).buffer), metaBytes, memory];
    (snapshot.floppies || []).forEach(function (f) { if (f) parts.push(f.bytes); });
    const total = parts.reduce(function (sum, p) { return sum + p.length; }, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach(function (p) { out.set(p, offset); offset += p.length; });
    return out;
  }

  function readMeta(bytes) {
    const head = MAGIC.length + 5;
    if (!bytes || bytes.length < head) throw new Error("Not a PCE_ST snapshot");
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error("Not a PCE_ST snapshot");
    if (bytes[MAGIC.length] !== VERSION) throw new Error("Unsupported snapshot version " + bytes[MAGIC.length]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaLength = view.getUint32(MAGIC.length + 1, true);
    if (metaLength > bytes.length - head) throw new Error("The snapshot is truncated");
    let meta;
    try { meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(head, head + metaLength))); }
    catch (err) { throw new Error("The snapshot header is not valid"); }
    if (!meta || meta.format !== "pce-st-snapshot" || !(meta.memorySize > 0) || meta.memorySize > MAX_MEMORY) throw new Error("The snapshot header is not valid");
    return { meta: meta, dataStart: head + metaLength };
  }

  // Returns { meta, snapshot: { version, config, memory, floppies } }.
  async function decode(bytes) {
    const info = readMeta(bytes);
    const meta = info.meta;
    let pos = info.dataStart;
    const take = function (length) {
      if (!(length >= 0) || pos + length > bytes.length) throw new Error("The snapshot is truncated");
      const part = bytes.subarray(pos, pos + length);
      pos += length;
      return part;
    };
    const stored = take(meta.memoryStored);
    let memory;
    if (meta.memoryCompression === "deflate") {
      if (!hasStreams()) throw new Error("This browser cannot decompress snapshots");
      memory = await pump(new Uint8Array(stored), new root.DecompressionStream("deflate"));
    } else {
      memory = new Uint8Array(stored);
    }
    if (memory.length !== meta.memorySize) throw new Error("The snapshot memory is corrupt");
    const floppies = (meta.floppies || []).map(function (f) {
      return f ? { name: String(f.name), bytes: new Uint8Array(take(f.size)) } : null;
    });
    return { meta: meta, snapshot: { version: 1, config: meta.config, memory: memory, floppies: floppies } };
  }

  root.PCE_STSnapshot = { encode: encode, decode: decode, readMeta: readMeta };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PCE_STSnapshot;
})(typeof window !== "undefined" ? window : globalThis);
