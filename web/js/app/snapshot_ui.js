// Snapshot panel: a quick-save slot in IndexedDB plus export/import of snapshot files.
(function () {
  "use strict";

  const DB_NAME = "pce_st_snapshots";
  const STORE = "slots";
  const QUICK = "quick";
  const EXTENSION = ".pcestsnap";

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("IndexedDB is unavailable")); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("Could not open snapshot storage")); };
    });
  }

  function withStore(mode, action) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(request ? request.result : undefined); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error || new Error("Snapshot storage failed")); };
      });
    });
  }

  function exportName(time) {
    const d = new Date(time);
    const p = function (n) { return String(n).padStart(2, "0"); };
    return "PCE_ST-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + EXTENSION;
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // options: { app, panel, getRomLabel(), onRestored(config) }
  function init(options) {
    const app = options.app, panel = options.panel;
    const saveBtn = panel.querySelector(".snapshot-save-btn");
    const loadBtn = panel.querySelector(".snapshot-load-btn");
    const exportBtn = panel.querySelector(".snapshot-export-btn");
    const importBtn = panel.querySelector(".snapshot-import-btn");
    const importInput = panel.querySelector(".snapshot-import-input");
    const statusEl = panel.querySelector(".snapshot-status");
    const slotState = panel.querySelector(".snapshot-slot-state");
    const slotMeta = panel.querySelector(".snapshot-slot-meta");
    let busy = false;

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = "snapshot-status" + (kind ? " " + kind : "");
    }

    function describe(meta, size) {
      const mb = (size / (1024 * 1024)).toFixed(2);
      const floppies = (meta.floppies || []).map(function (f, i) { return f ? "ABCD"[i] + ": " + f.name : null; }).filter(Boolean);
      return new Date(meta.created).toLocaleString() + "  |  ROM " + (meta.romLabel || "?") + "  |  " +
        (meta.config && meta.config.mono ? "mono" : "color") + ", " + (meta.config ? meta.config.ramKB : "?") + "K  |  " +
        mb + " MB" + (floppies.length ? "  |  " + floppies.join(", ") : "");
    }

    function refreshSlot() {
      return withStore("readonly", function (store) { return store.get(QUICK); }).then(function (record) {
        loadBtn.disabled = !record;
        slotState.textContent = record ? "Saved" : "Empty";
        slotState.classList.toggle("is-ready", !!record);
        slotState.classList.toggle("is-empty", !record);
        slotMeta.textContent = record ? describe(record.meta, record.bytes.length) : "No browser snapshot saved yet.";
      }).catch(function () {
        slotState.textContent = "Unavailable";
        slotMeta.textContent = "The browser storage cannot be used.";
      });
    }

    async function capture() {
      const snap = await app.saveSnapshot();
      return PCE_STSnapshot.encode({ config: snap.config, romLabel: options.getRomLabel(), memory: snap.memory, floppies: snap.floppies });
    }

    async function restore(bytes) {
      const decoded = await PCE_STSnapshot.decode(bytes);
      const label = options.getRomLabel();
      if (decoded.meta.romLabel && decoded.meta.romLabel !== label) {
        throw new Error("This snapshot needs the ROM \"" + decoded.meta.romLabel + "\" (the current ROM is \"" + label + "\"). Choose that ROM first.");
      }
      await app.loadSnapshot(decoded.snapshot);
      options.onRestored(decoded.snapshot.config);
    }

    function guarded(label, work) {
      return function () {
        if (busy) return;
        busy = true;
        setStatus(label, "busy");
        Promise.resolve().then(work).catch(function (err) {
          setStatus(err && err.message ? err.message : String(err), "error");
        }).finally(function () { busy = false; });
      };
    }

    saveBtn.addEventListener("click", guarded("Saving snapshot...", async function () {
      const bytes = await capture();
      const meta = PCE_STSnapshot.readMeta(bytes).meta;
      await withStore("readwrite", function (store) { return store.put({ id: QUICK, meta: meta, bytes: bytes }); });
      await refreshSlot();
      setStatus("Snapshot saved in the quick slot.", "success");
    }));
    loadBtn.addEventListener("click", guarded("Restoring snapshot...", async function () {
      const record = await withStore("readonly", function (store) { return store.get(QUICK); });
      if (!record) throw new Error("The quick slot is empty.");
      await restore(record.bytes);
      setStatus("Snapshot restored.", "success");
    }));
    exportBtn.addEventListener("click", guarded("Exporting snapshot...", async function () {
      const bytes = await capture();
      download(bytes, exportName(Date.now()));
      setStatus("Snapshot exported.", "success");
    }));
    importBtn.addEventListener("click", function () { importInput.click(); });
    importInput.addEventListener("change", function () {
      const file = importInput.files && importInput.files[0];
      importInput.value = "";
      if (!file) return;
      guarded("Importing snapshot...", async function () {
        await restore(new Uint8Array(await file.arrayBuffer()));
        setStatus("Snapshot imported and restored.", "success");
      })();
    });

    refreshSlot();
    return { refresh: refreshSlot };
  }

  window.PCE_STSnapshotUI = { init: init };
})();
