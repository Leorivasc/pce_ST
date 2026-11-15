// The user's system ROMs (TOS images), kept in IndexedDB so they survive reloads.
// A record is { name, bytes, size, savedAt }; names are unique. Without IndexedDB the
// library works in memory for the session.
(function (root) {
  "use strict";

  const DB_NAME = "pce_st_rom_library";
  const DB_VERSION = 1;
  const STORE = "roms";
  const ROM_SIZE = 192 * 1024;

  function toBytes(data) {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new Uint8Array(0);
  }

  function create() {
    const memory = new Map();
    let db = null;
    let initPromise = null;

    function init() {
      if (initPromise) return initPromise;
      initPromise = new Promise(function (resolve) {
        if (!root.indexedDB) { resolve(); return; }
        let request;
        try { request = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { resolve(); return; }
        request.onupgradeneeded = function (event) {
          const database = event.target.result;
          if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "name" });
        };
        request.onsuccess = function (event) { db = event.target.result; resolve(); };
        request.onerror = function () { console.error("ROM library IndexedDB init failed:", request.error); resolve(); };
      });
      return initPromise;
    }

    function run(mode, action) {
      return init().then(function () {
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(STORE, mode);
          const request = action(tx.objectStore(STORE));
          tx.oncomplete = function () { resolve(request ? request.result : undefined); };
          tx.onerror = tx.onabort = function () { reject(tx.error || new Error("ROM library transaction failed")); };
        });
      });
    }

    function normalizeName(name) {
      const value = String(name || "").trim();
      if (!value) throw new Error("A ROM needs a name");
      return value;
    }

    return {
      init: init,
      put: function (name, data) {
        const key = normalizeName(name);
        const bytes = toBytes(data);
        if (bytes.length !== ROM_SIZE) throw new Error("A ROM must be a 192K image (received " + bytes.length + " bytes).");
        const record = { name: key, bytes: bytes, size: bytes.length, savedAt: Date.now() };
        return init().then(function () {
          if (!db) { memory.set(key, record); return; }
          return run("readwrite", function (store) { return store.put(record); });
        });
      },
      get: function (name) {
        const key = normalizeName(name);
        return init().then(function () {
          if (!db) return memory.get(key) || null;
          return run("readonly", function (store) { return store.get(key); }).then(function (record) { return record || null; });
        });
      },
      // Records without their bytes, oldest first.
      list: function () {
        return init().then(function () {
          if (!db) return Array.from(memory.values());
          return run("readonly", function (store) { return store.getAll(); });
        }).then(function (records) {
          return records.map(function (r) { return { name: r.name, size: r.size, savedAt: r.savedAt }; })
            .sort(function (a, b) { return a.savedAt - b.savedAt; });
        });
      },
      remove: function (name) {
        const key = normalizeName(name);
        return init().then(function () {
          if (!db) { memory.delete(key); return; }
          return run("readwrite", function (store) { return store.delete(key); });
        });
      },
    };
  }

  root.PCE_STRomLibrary = { create: create, ROM_SIZE: ROM_SIZE };
})(typeof window !== "undefined" ? window : this);
