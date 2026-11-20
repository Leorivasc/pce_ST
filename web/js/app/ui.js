// PCE_ST user interface: toolbar, screen sizing, fullscreen, themes, mobile
// tools, keyboard (physical and on-screen), joystick and mouse input, ROM and
// floppy loading. It drives the
// machine through PCE_STAppProxy (js/core/app_proxy.js).
(function () {
  "use strict";

  const ROM_URL = "../roms/emutos/etos192us.img";
  const DEFAULT_ROM_NAME = "EmuTOS";
  const SCREEN_ASPECT = 4 / 3;            // the ST's monitors are 4:3
  const MOBILE_QUERY = "(max-width: 980px)";
  const TAP_MAX_MS = 250;                 // touch: a tap is a short touch...
  const TAP_MAX_MOVE_PX = 8;              // ...that barely moves
  const LONG_PRESS_MS = 500;              // touch: long press = right click
  const CLICK_HOLD_MS = 40;               // how long a synthetic click stays pressed

  const UI_THEMES = Object.freeze({
    classic: true, "800xl": true, xegs: true, "65xe": true, "400-800": true, st: true, "2600": true,
  });
  const KEYS = Object.freeze({
    theme: "pce_st_ui_theme", crt: "pce_st_crt_enabled", monitor: "pce_st_monitor", ram: "pce_st_ram_kb",
    keyJoystick: "pce_st_key_joystick",
  });
  const RAM_SIZES_KB = [512, 1024, 2048, 4096];
  // Physical keys that drive the joystick when the keyboard joystick is on.
  const KEY_JOYSTICK = Object.freeze({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", ControlLeft: "fire" });

  function readPref(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (e) { return null; }
  }

  function writePref(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, String(value)); } catch (e) { /* keep working without storage */ }
  }

  function normalizeTheme(value) {
    const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(UI_THEMES, text) ? text : null;
  }

  function applyTheme(value) {
    const theme = normalizeTheme(value) || "classic";
    document.documentElement.dataset.uiTheme = theme;
    return theme;
  }

  function readMonitorPref() { return readPref(KEYS.monitor) === "color" ? "color" : "mono"; }

  function readRamPref() {
    const kb = Number(readPref(KEYS.ram));
    return RAM_SIZES_KB.indexOf(kb) >= 0 ? kb : 1024;
  }

  function isMobileViewport() {
    return typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
  }

  function fetchRom() {
    return fetch(ROM_URL).then(function (resp) {
      if (!resp.ok) throw new Error("Could not load the system ROM (" + resp.status + ")");
      return resp.arrayBuffer();
    });
  }

  function readFileBytes(file) {
    return file.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  async function boot() {
    const $ = function (id) { return document.getElementById(id); };
    const canvas = $("screen");
    canvas.tabIndex = 0;
    const screenViewport = canvas.parentElement;
    const layoutRoot = screenViewport.closest(".layout");
    const btnStart = $("btnStart");
    const btnReset = $("btnReset");
    const btnAudio = $("btnAudio");
    const btnCrt = $("btnCrt");
    const btnFullscreen = $("btnFullscreen");
    const btnAppFullscreen = $("btnAppFullscreen");
    const btnTurbo = $("btnTurbo");
    const btnMouse = $("btnMouse");
    const btnSaveFloppy = $("btnSaveFloppy");
    const btnControlsCollapse = $("btnControlsCollapse");
    const secondaryControls = $("secondaryControls");
    const monitorSelect = $("monitorSelect");
    const ramSelect = $("ramSelect");
    const uiThemeSelect = $("uiThemeSelect");
    const romInput = $("romInput");
    const romName = $("romName");
    const romStatus = $("romStatus");
    const diskInput = $("disk1");
    const statusLine = $("statusLine");
    const romNotice = $("romNotice");
    const romNoticeMessage = $("romNoticeMessage");
    const romNoticeClose = $("romNoticeClose");
    const romNoticeLoad = $("romNoticeLoad");
    const mobileToolsButton = $("mobileToolsButton");
    const mobileToolsSheet = $("mobileToolsSheet");
    const mobileToolsClose = $("mobileToolsClose");
    const mobilePanelBackdrop = $("mobilePanelBackdrop");
    const btnJoystick = $("btnJoystick");
    const btnKeyJoystick = $("btnKeyJoystick");
    const btnKeyboard = $("btnKeyboard");
    const joystickPanel = $("joystickPanel");
    const keyboardPanel = $("keyboardPanel");

    // The CRT filter starts as stored in the preferences; "?crt=0" or "?crt=1" in
    // the URL overrides it for this session (it is not stored).
    const urlCrt = new URLSearchParams(window.location.search).get("crt");
    let crtEnabled = urlCrt === "0" ? false : urlCrt === "1" ? true : readPref(KEYS.crt) !== "false";
    let renderW = 0;
    let renderH = 0;
    let pendingRunPause = null;           // "start" | "pause" while a request is in flight
    let didCleanup = false;
    let romLabel = DEFAULT_ROM_NAME;
    let romFailure = null;

    // ---- preferences ----

    uiThemeSelect.value = applyTheme(readPref(KEYS.theme) || uiThemeSelect.value);
    monitorSelect.value = readMonitorPref();
    ramSelect.value = String(readRamPref());

    function updateCrtButton() {
      btnCrt.classList.toggle("active", crtEnabled);
      btnCrt.setAttribute("aria-pressed", String(crtEnabled));
      btnCrt.title = crtEnabled ? "CRT on: click for a clean image." : "CRT off: click to enable the CRT filter.";
      canvas.classList.toggle("crtDisabled", !crtEnabled);
    }
    canvas.classList.add("crtEnabled");
    updateCrtButton();

    // ---- the machine ----

    // ROM library: the ROMs the user loaded stay in IndexedDB; the choice is remembered.
    const ROM_CHOICE_KEY = "pce_st_rom_choice";
    const romLibrary = PCE_STRomLibrary.create();
    const romSelect = $("romSelect");
    const btnRemoveRom = $("btnRemoveRom");
    let romChoice = "";

    async function refreshRomSelect() {
      let records = [];
      try { records = await romLibrary.list(); } catch (err) { console.error("ROM library unavailable:", err); }
      while (romSelect.options.length > 1) romSelect.remove(1);
      records.forEach(function (record) {
        const option = document.createElement("option");
        option.value = record.name;
        option.textContent = record.name;
        romSelect.appendChild(option);
      });
      if (!records.some(function (r) { return r.name === romChoice; })) romChoice = "";
      romSelect.value = romChoice;
      btnRemoveRom.disabled = !romChoice;
    }

    let rom = null;
    try {
      const saved = (function () { try { return window.localStorage.getItem(ROM_CHOICE_KEY) || ""; } catch (e) { return ""; } })();
      if (saved) {
        const record = await romLibrary.get(saved).catch(function () { return null; });
        if (record) { rom = record.bytes; romChoice = saved; romLabel = saved; }
      }
      if (!rom) rom = await fetchRom();
    } catch (err) {
      romFailure = err.message;
    }
    refreshRomSelect();

    const app = window.PCE_STAppProxy.create({
      canvas: canvas,
      rom: rom,
      config: { model: "st", mono: monitorSelect.value === "mono", ramKB: Number(ramSelect.value) },
      crtEnabled: crtEnabled,
      audioEnabled: btnAudio.classList.contains("active"),
      turbo: false,
    });
    window.PCE_ST_APP = app;

    // The disk library lives on the main thread and drives the machine through the proxy.
    // The image index of a mounted floppy is its drive number (0 = A:, 1 = B:).
    const mountedIds = [null, null];   // library entry mounted in each drive
    const library = PCE_STDiskLibrary.createApi().create({
      mountDisk: async function (bytes, name, slot, details) {
        const result = await app.mountFloppy(slot, bytes, name);
        if (!result || !result.ok) throw new Error("The machine did not accept the floppy");
        mountedIds[slot] = details && details.diskLibraryId || null;
        return { imageIndex: slot, deviceSlot: slot };
      },
      unmountDisk: function (slot) { mountedIds[slot] = null; return app.unmountFloppy(slot); },
      getMountedDiskForDeviceSlot: function (slot) {
        return mountedIds[slot] ? { libraryId: mountedIds[slot], imageIndex: slot } : null;
      },
      getDiskImageBytes: async function (imageIndex) {
        const floppy = await app.flushFloppy(imageIndex);
        return floppy ? floppy.bytes : null;
      },
    });
    window.PCE_ST_LIBRARY = library;
    // Floppies mounted last time are mounted again; the guest's writes flow back into
    // the library a moment after they happen (the worker reports "modified").
    library.init().then(function () { return library.restoreMounts(); })
      .catch(function (err) { console.error("Disk library unavailable:", err); });
    const syncTimers = [0, 0];
    app.onStateChange(function (state) {
      [0, 1].forEach(function (slot) {
        const floppy = state.floppies && state.floppies[slot];
        if (!floppy || !floppy.modified || syncTimers[slot] || !library.isReady()) return;
        syncTimers[slot] = setTimeout(function () {
          syncTimers[slot] = 0;
          library.onDiskMediaChanged(slot).catch(function (err) { console.error("Could not save the floppy:", err); });
        }, 1500);
      });
    });
    window.addEventListener("pagehide", function () {
      // Best effort: pull the guest's last writes into the pending changes.
      [0, 1].forEach(function (slot) { if (app.hasMountedFloppy(slot)) library.onDiskMediaChanged(slot); });
    });

    // ---- layout schemes and the library panel ----

    const LAYOUT_SCHEME_KEY = "pce_st_layout_scheme";
    const LAYOUT_RATIO_KEY = "pce_st_layout_column_ratio";
    const LAYOUT_SCHEMES = { emulation: { panels: [] }, work: { panels: ["diskLibraryPanel"] } };
    const layoutSplitter = $("layoutSplitter");
    const btnDiskLibrary = $("btnDiskLibrary");
    const diskLibraryPanel = $("diskLibraryPanel");
    const layoutSchemeButtons = Array.from(document.querySelectorAll("[data-layout-scheme]"));

    function readPref(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function writePref(key, value) {
      try { window.localStorage.setItem(key, String(value)); } catch (e) { /* optional */ }
    }

    let layoutScheme = Object.prototype.hasOwnProperty.call(LAYOUT_SCHEMES, readPref(LAYOUT_SCHEME_KEY))
      ? readPref(LAYOUT_SCHEME_KEY) : "work";
    let layoutColumnRatio = (function () {
      const value = Number(readPref(LAYOUT_RATIO_KEY));
      return value >= 0.2 && value <= 0.6 ? value : 0.34;
    })();

    const snapshotPanel = $("snapshotPanel");
    const btnSnapshots = $("btnSnapshots");

    // On a phone the tools column is a full-screen sheet with a backdrop, one panel at a time.
    function updateToolsSheet() {
      const sheet = (!diskLibraryPanel.hidden || !snapshotPanel.hidden) && isMobileViewport();
      document.body.classList.toggle("mobile-panel-open", sheet);
      if (sheet) mobilePanelBackdrop.hidden = false;
      else if (mobileToolsSheet.hidden) mobilePanelBackdrop.hidden = true;
      syncMobileToolButtons();
      resizeCrtCanvas();
    }

    function setToolPanel(panel, button, visible) {
      panel.hidden = !visible;
      button.classList.toggle("active", visible);
      button.setAttribute("aria-pressed", String(visible));
    }

    function setLibraryPanelVisible(visible) {
      setToolPanel(diskLibraryPanel, btnDiskLibrary, visible);
      if (visible && isMobileViewport()) setToolPanel(snapshotPanel, btnSnapshots, false);
      updateToolsSheet();
    }

    function setSnapshotPanelVisible(visible) {
      setToolPanel(snapshotPanel, btnSnapshots, visible);
      if (visible && isMobileViewport()) setToolPanel(diskLibraryPanel, btnDiskLibrary, false);
      updateToolsSheet();
    }

    function applyLayoutScheme(value, persist) {
      layoutScheme = Object.prototype.hasOwnProperty.call(LAYOUT_SCHEMES, value) ? value : "work";
      if (persist) writePref(LAYOUT_SCHEME_KEY, layoutScheme);
      layoutRoot.dataset.layoutScheme = layoutScheme;
      layoutRoot.style.setProperty("--tools-column-width", (layoutColumnRatio * 100).toFixed(3) + "%");
      layoutSchemeButtons.forEach(function (button) {
        const active = button.getAttribute("data-layout-scheme") === layoutScheme;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      setLibraryPanelVisible(LAYOUT_SCHEMES[layoutScheme].panels.indexOf("diskLibraryPanel") >= 0 && !isMobileViewport());
    }

    function columnBounds() {
      const style = window.getComputedStyle(layoutRoot);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const width = Math.max(1, layoutRoot.clientWidth - padding);
      const min = Math.min(0.6, 240 / width);
      return { min: min, max: Math.max(min, Math.min(0.6, (width - 330) / width)) };
    }

    function setLayoutColumnRatio(value, persist) {
      const bounds = columnBounds();
      layoutColumnRatio = Math.min(bounds.max, Math.max(bounds.min, Number(value)));
      if (!Number.isFinite(layoutColumnRatio)) layoutColumnRatio = 0.34;
      layoutRoot.style.setProperty("--tools-column-width", (layoutColumnRatio * 100).toFixed(3) + "%");
      layoutSplitter.setAttribute("aria-valuenow", String(Math.round(layoutColumnRatio * 100)));
      if (persist) writePref(LAYOUT_RATIO_KEY, layoutColumnRatio);
      resizeCrtCanvas();
    }

    layoutSchemeButtons.forEach(function (button) {
      button.addEventListener("click", function () { applyLayoutScheme(button.getAttribute("data-layout-scheme"), true); });
    });

    layoutSplitter.addEventListener("pointerdown", function (e) {
      const pointerId = e.pointerId;
      try { layoutSplitter.setPointerCapture(pointerId); } catch (err) { /* capture is optional */ }
      document.body.classList.add("layout-column-resizing");
      const move = function (ev) {
        const rect = layoutRoot.getBoundingClientRect();
        const style = window.getComputedStyle(layoutRoot);
        const left = rect.left + (parseFloat(style.paddingLeft) || 0);
        const width = layoutRoot.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        setLayoutColumnRatio((ev.clientX - left) / Math.max(1, width), false);
      };
      const end = function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        document.body.classList.remove("layout-column-resizing");
        writePref(LAYOUT_RATIO_KEY, layoutColumnRatio);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      e.preventDefault();
    });
    layoutSplitter.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      setLayoutColumnRatio(layoutColumnRatio + (e.key === "ArrowRight" ? 0.02 : -0.02), true);
      e.preventDefault();
    });

    PCE_STDiskLibraryUI.init({
      app: {
        getDiskLibrary: function () { return library; },
        // The drive LEDs of the panel follow the floppy controller (events from the core).
        onDiskActivity: function (fn) { app.onDiskActivity(fn); },
      },
      panel: diskLibraryPanel,
      button: btnDiskLibrary,
    });
    // The panel's own click handler toggles the panel; this one (registered after it)
    // follows the result.
    btnDiskLibrary.addEventListener("click", function () { setLibraryPanelVisible(!diskLibraryPanel.hidden); });
    btnSnapshots.addEventListener("click", function () { setSnapshotPanelVisible(snapshotPanel.hidden); });

    PCE_STRemoteSyncUI.init({
      app: { getDiskLibrary: function () { return library; } },
      panel: diskLibraryPanel,
      buttons: [btnDiskLibrary, document.querySelector('[data-mobile-proxy="btnDiskLibrary"]')],
    });

    PCE_STSnapshotUI.init({
      app: app,
      panel: snapshotPanel,
      getRomLabel: function () { return romLabel; },
      onRestored: function (config) {
        if (config) {
          monitorSelect.value = config.mono ? "mono" : "color";
          ramSelect.value = String(config.ramKB);
        }
        // The restored machine holds the snapshot's floppies: no library entry is mounted.
        mountedIds[0] = mountedIds[1] = null;
        library.reconcileMounts().catch(function () { /* the panel refreshes on the next change */ });
        updateStatus();
      },
    });
    applyLayoutScheme(layoutScheme, false);

    // On-screen keyboard and joystick: they feed the same entry points as the
    // physical devices.
    const keyboard = window.PCE_STKeyboard.create({
      container: $("stKeyboard"),
      onKeyDown: function (code) { app.onKeyDown(code); },
      onKeyUp: function (code) { app.onKeyUp(code); },
    });
    const joystick = window.PCE_STJoystick.create({
      area: $("joystickArea"),
      stick: $("joystickStick"),
      fireButton: $("fireButton"),
      glows: { up: $("glowUp"), down: $("glowDown"), left: $("glowLeft"), right: $("glowRight") },
      onChange: function (pad) { app.joystick(pad); },
    });
    window.PCE_ST_KEYBOARD = keyboard;

    // ---- screen sizing ----

    function reservedHeight() { return 0; }

    function resizeDisplayCanvas() {
      const rect = screenViewport.getBoundingClientRect();
      const maxW = Math.max(1, Math.floor(rect.width || canvas.width));
      let cssW = maxW;
      let cssH = Math.round(cssW / SCREEN_ASPECT);
      const vv = window.visualViewport;
      const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      let availableH;
      if (isViewportFullscreen()) {
        availableH = Math.floor(visibleBottom - rect.top - 8);
      } else if (layoutRoot) {
        const layoutRect = layoutRoot.getBoundingClientRect();
        availableH = Math.floor(layoutRoot.clientHeight - Math.max(0, rect.top - layoutRect.top) - 8);
      } else {
        availableH = Math.floor(visibleBottom - rect.top - 8);
      }
      availableH -= reservedHeight();
      const maxH = Math.max(1, availableH || Math.floor(rect.height || canvas.height));
      if (cssH > maxH) {
        cssH = maxH;
        cssW = Math.round(cssH * SCREEN_ASPECT);
      }
      const nextW = Math.max(1, cssW) + "px";
      const nextH = Math.max(1, cssH) + "px";
      if (canvas.style.width !== nextW) canvas.style.width = nextW;
      if (canvas.style.height !== nextH) canvas.style.height = nextH;
    }

    // The render size follows the on-screen size so the CRT filter works at the
    // display's real resolution.
    function resizeCrtCanvas() {
      resizeDisplayCanvas();
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const video = app.getVideoSize();
      const targetW = Math.max(video.width || 320, Math.round((rect.width || 320) * dpr));
      const targetH = Math.max(video.height || 200, Math.round((rect.height || 200) * dpr));
      if (renderW !== targetW || renderH !== targetH) {
        renderW = targetW;
        renderH = targetH;
        app.setRenderSize(targetW, targetH);
      }
    }

    // The layout decides which panels show only on a desktop-sized screen: when the viewport
    // crosses the phone breakpoint (a rotated tablet, a narrowed window), apply it again, so
    // the Work layout's library does not stay open as a full-screen sheet over the screen.
    let lastMobileViewport = isMobileViewport();
    function onLayoutResize() {
      const mobile = isMobileViewport();
      if (!mobile) setMobileToolsOpen(false);
      if (mobile !== lastMobileViewport) {
        lastMobileViewport = mobile;
        applyLayoutScheme(layoutScheme, false);
      }
      resizeCrtCanvas();
    }
    window.addEventListener("resize", onLayoutResize);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", onLayoutResize);
    requestAnimationFrame(onLayoutResize);

    // ---- fullscreen ----

    function getFullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
    function isViewportFullscreen() { return getFullscreenElement() === screenViewport; }
    function isAppFullscreen() { return getFullscreenElement() === document.documentElement; }

    function requestFullscreen(el) {
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      return fn ? fn.call(el) : Promise.reject(new Error("Fullscreen is not supported"));
    }

    function exitFullscreen() {
      const fn = document.exitFullscreen || document.webkitExitFullscreen;
      return fn ? fn.call(document) : Promise.resolve();
    }

    function setFullscreenButton(btn, active, activeIcon, idleIcon, activeTitle, idleTitle) {
      btn.innerHTML = '<i class="fa-solid fa-' + (active ? activeIcon : idleIcon) + '"></i>';
      btn.title = active ? activeTitle : idleTitle;
      btn.setAttribute("aria-label", btn.title);
    }

    function updateFullscreenButtons() {
      setFullscreenButton(btnFullscreen, isViewportFullscreen(), "compress", "expand",
        "Exit fullscreen mode and return to the normal emulator layout.",
        "Enter fullscreen mode for the emulator display area.");
      setFullscreenButton(btnAppFullscreen, isAppFullscreen(), "compress", "window-maximize",
        "Exit fullscreen mode for the complete emulator workspace.",
        "Enter fullscreen mode for the complete emulator workspace.");
    }

    function showFullscreenHint() {
      const existing = screenViewport.querySelector(".fullscreen-hint");
      if (existing) existing.remove();
      const hint = document.createElement("div");
      hint.className = "fullscreen-hint";
      hint.textContent = "Press Escape or F11 to exit fullscreen";
      hint.style.cssText =
        "position:absolute;bottom:1.5em;left:50%;transform:translateX(-50%);" +
        "background:rgba(0,0,0,0.65);color:#fff;padding:0.4em 1em;border-radius:4px;" +
        "font:14px/1.4 sans-serif;pointer-events:none;z-index:9999;opacity:1;transition:opacity 0.5s ease;";
      screenViewport.appendChild(hint);
      setTimeout(function () {
        hint.style.opacity = "0";
        setTimeout(function () { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 500);
      }, 2500);
    }

    function toggleFullscreenOn(el, isActive) {
      let op;
      if (isActive()) op = exitFullscreen();
      else if (getFullscreenElement()) op = exitFullscreen().then(function () { return requestFullscreen(el); });
      else op = requestFullscreen(el);
      Promise.resolve(op).then(function () {
        updateFullscreenButtons();
        resizeCrtCanvas();
        focusCanvas();
      }).catch(function () { /* fullscreen refused: nothing to do */ });
    }

    function onFullscreenChange() {
      updateFullscreenButtons();
      resizeCrtCanvas();
      if (isViewportFullscreen()) showFullscreenHint();
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    function focusCanvas() { try { canvas.focus({ preventScroll: true }); } catch (e) { canvas.focus(); } }

    // ---- on-screen keyboard and joystick panels ----

    function setPanelButton(btn, enabled, showTitle, hideTitle) {
      btn.classList.toggle("active", enabled);
      btn.setAttribute("aria-pressed", String(enabled));
      btn.title = enabled ? hideTitle : showTitle;
      btn.setAttribute("aria-label", btn.title);
    }

    function setKeyboardEnabled(enabled) {
      keyboardPanel.hidden = !enabled;
      setPanelButton(btnKeyboard, enabled, "Show the on-screen keyboard.", "Hide the on-screen keyboard.");
      if (!enabled) keyboard.releaseAll();
      resizeCrtCanvas();
      syncMobileInputButtons();
    }

    function setJoystickEnabled(enabled) {
      joystickPanel.hidden = !enabled;
      setPanelButton(btnJoystick, enabled, "Show the on-screen joystick (port 1).", "Hide the on-screen joystick.");
      if (!enabled) joystick.reset();
      app.setJoystickEnabled(enabled);
      resizeCrtCanvas();
      syncMobileInputButtons();
    }

    // A physical gamepad drives the joystick too. Using one switches the machine's
    // joystick mode on (the keypad then stops typing digits), even with the on-screen
    // joystick hidden. The poller only reports changes, so an idle pad does nothing.
    PCE_STGamepad.install(function (state) {
      if ((state.up || state.down || state.left || state.right || state.fire) && !app.getJoystickEnabled()) {
        app.setJoystickEnabled(true);
      }
      app.joystick(state);
    });

    // Keyboard joystick: the arrow keys and Left Ctrl act as the stick and the fire button of
    // port 1 and are not sent to the ST as keys. The choice is remembered. Turning it on
    // switches the machine's joystick mode on (the keypad then stops typing digits).
    let keyJoystick = readPref(KEYS.keyJoystick) === "1";
    const keyPad = { up: false, down: false, left: false, right: false, fire: false };

    function releaseKeyPad() {
      const was = Object.keys(keyPad).some(function (k) { return keyPad[k]; });
      Object.keys(keyPad).forEach(function (k) { keyPad[k] = false; });
      if (was) app.joystick(Object.assign({}, keyPad));
    }

    function setKeyJoystick(enabled, remember) {
      keyJoystick = !!enabled;
      if (remember) writePref(KEYS.keyJoystick, keyJoystick ? "1" : "0");
      btnKeyJoystick.classList.toggle("active", keyJoystick);
      btnKeyJoystick.setAttribute("aria-pressed", String(keyJoystick));
      btnKeyJoystick.title = keyJoystick ? "The arrow keys and Left Ctrl are the joystick (port 1). Click to use them as keys again." : "Use the arrow keys and Left Ctrl as the joystick (port 1).";
      btnKeyJoystick.setAttribute("aria-label", btnKeyJoystick.title);
      if (keyJoystick) app.setJoystickEnabled(true); else releaseKeyPad();
    }

    btnKeyJoystick.addEventListener("click", function () { setKeyJoystick(!keyJoystick, true); });
    setKeyJoystick(keyJoystick, false);

    btnKeyboard.addEventListener("click", function () { setKeyboardEnabled(keyboardPanel.hidden); });
    btnJoystick.addEventListener("click", function () { setJoystickEnabled(joystickPanel.hidden); });

    // ---- toolbar state ----

    function setRunPauseButton(running, pending) {
      btnStart.innerHTML = pending
        ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>'
        : running ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
      btnStart.classList.toggle("pending", !!pending);
      const label = pending === "pause" ? "Pausing emulation..."
        : pending === "start" ? "Starting emulation..."
          : running ? "Pause emulation. Use this button again to continue from the current state."
            : "Start emulation.";
      btnStart.title = label;
      btnStart.setAttribute("aria-label", label);
      btnStart.setAttribute("aria-busy", pending ? "true" : "false");
    }

    function updateRomUi() {
      const loaded = app.hasRom();
      romStatus.classList.toggle("loaded", loaded);
      romName.textContent = romLabel;
      $("toolbarRom").title = loaded
        ? "System ROM loaded: " + romLabel + ". Click to load another TOS or EmuTOS ROM image."
        : "System ROM is not loaded. Click to load a TOS or EmuTOS ROM image.";
      if (!romNotice) return;
      if (loaded) {
        romNotice.hidden = true;
      } else if (!romNotice.dataset.dismissed) {
        romNoticeMessage.textContent = romFailure || "Load a TOS or EmuTOS ROM image (192K) to start the emulator.";
        romNotice.hidden = false;
      }
    }

    function updateFloppyUi() {
      const info = app.getFloppyInfo(0);
      btnSaveFloppy.disabled = !info;
      btnSaveFloppy.title = info && info.readOnly
        ? "Download the original Pasti image of floppy A: (" + info.name + "). It is read-only: the changes the program makes are not saved."
        : info
        ? "Save floppy A: (" + info.name + ") with the changes the program made, as a .st file."
        : "Save floppy A: as a .st file (no floppy is mounted).";
      $("toolbarDiskOpen").title = info
        ? "Floppy in A: " + info.name + ". Click to open another image (.st)."
        : "Open a floppy disk image (.st) in drive A:.";
    }

    function updateStatus() {
      const state = app.getState();
      const busy = !!pendingRunPause;
      setRunPauseButton(pendingRunPause ? state.running : state.running, pendingRunPause);
      btnStart.disabled = !app.isReady() || pendingRunPause === "pause";
      btnReset.disabled = !app.hasRom() || busy;
      btnTurbo.classList.toggle("active", !!state.turbo);
      btnTurbo.setAttribute("aria-pressed", String(!!state.turbo));
      btnAudio.classList.toggle("active", !!state.audioEnabled);
      btnAudio.setAttribute("aria-pressed", String(!!state.audioEnabled));
      const mono = state.config && state.config.mono !== false ? "mono" : "color";
      if (monitorSelect.value !== mono) monitorSelect.value = mono;
      if (state.config && ramSelect.value !== String(state.config.ramKB)) ramSelect.value = String(state.config.ramKB);
      updateRomUi();
      updateFloppyUi();
      syncMobileToolButtons();
      if (state.video.width) resizeCrtCanvas();
    }

    function renderStatusLine(stats) {
      const state = app.getState();
      const parts = [];
      if (!state.running) parts.push("Paused");
      if (stats) parts.push(stats.fps.toFixed(0) + " fps", stats.speed.toFixed(2) + "x");
      if (state.video.width) parts.push(state.video.width + "x" + state.video.height);
      statusLine.textContent = parts.join(" · ");
    }

    app.onStateChange(function () { updateStatus(); renderStatusLine(app.getStats()); });
    app.onStats(renderStatusLine);
    app.onError(function (message) { romFailure = message; updateRomUi(); console.error("[PCE_ST]", message); });
    app.onLog(function (text) { if (window.PCE_ST_LOG) window.PCE_ST_LOG.push(text); });

    // ---- run / pause / reset ----

    function runPauseRequest(action, request) {
      pendingRunPause = action;
      updateStatus();
      Promise.resolve().then(request).catch(function (err) {
        console.error("Failed to " + action + " emulation:", err);
      }).finally(function () {
        pendingRunPause = null;
        updateStatus();
      });
    }

    btnStart.addEventListener("click", function () {
      if (pendingRunPause) return;
      if (app.isRunning()) runPauseRequest("pause", function () { return app.pause(); });
      else runPauseRequest("start", function () { return app.start(); });
      focusCanvas();
    });

    btnReset.addEventListener("click", function () {
      pendingRunPause = "start";
      updateStatus();
      app.powerCycle().catch(function (err) { console.error("Reset failed:", err); }).finally(function () {
        pendingRunPause = null;
        updateStatus();
      });
      focusCanvas();
    });

    // ---- toggles ----

    function bindToggleButton(btn, onToggle) {
      btn.addEventListener("click", function () {
        const active = btn.classList.toggle("active");
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        onToggle(active);
      });
    }

    bindToggleButton(btnTurbo, function (active) { app.setTurbo(active); });
    bindToggleButton(btnAudio, function (active) { app.setAudioEnabled(active); });
    bindToggleButton(btnCrt, function (active) {
      crtEnabled = active;
      updateCrtButton();
      app.setCrtEnabled(active);
      writePref(KEYS.crt, active);
    });

    btnFullscreen.addEventListener("click", function () { toggleFullscreenOn(screenViewport, isViewportFullscreen); });
    btnAppFullscreen.addEventListener("click", function () { toggleFullscreenOn(document.documentElement, isAppFullscreen); });

    function setSecondaryControlsExpanded(expanded) {
      secondaryControls.hidden = !expanded;
      btnControlsCollapse.innerHTML = '<i class="fa-solid fa-chevron-' + (expanded ? "up" : "down") + '"></i>';
      const label = expanded ? "Collapse the secondary toolbar controls." : "Expand the secondary toolbar controls.";
      btnControlsCollapse.title = label;
      btnControlsCollapse.setAttribute("aria-label", label);
      btnControlsCollapse.setAttribute("aria-expanded", expanded ? "true" : "false");
      resizeCrtCanvas();
    }
    btnControlsCollapse.addEventListener("click", function () { setSecondaryControlsExpanded(secondaryControls.hidden); });

    uiThemeSelect.addEventListener("change", function () {
      const next = applyTheme(uiThemeSelect.value);
      uiThemeSelect.value = next;
      writePref(KEYS.theme, next);
    });

    // Hardware choices restart the machine.
    function applyHardwareChoice() {
      const mono = monitorSelect.value === "mono";
      const ramKB = Number(ramSelect.value);
      writePref(KEYS.monitor, mono ? "mono" : "color");
      writePref(KEYS.ram, ramKB);
      pendingRunPause = "start";
      updateStatus();
      app.configure({ mono: mono, ramKB: ramKB }).catch(function (err) {
        console.error("Could not apply the new hardware settings:", err);
      }).finally(function () { pendingRunPause = null; updateStatus(); });
    }
    monitorSelect.addEventListener("change", applyHardwareChoice);
    ramSelect.addEventListener("change", applyHardwareChoice);

    // ---- ROM and floppy ----

    function rememberRomChoice(name) {
      romChoice = name;
      try { window.localStorage.setItem(ROM_CHOICE_KEY, name); } catch (e) { /* optional */ }
    }

    // Switches the machine to another ROM image and restarts it.
    async function switchRom(bytes, label) {
      romLabel = label;
      romFailure = null;
      if (romNotice) delete romNotice.dataset.dismissed;
      await app.loadRom(bytes);
      await app.powerCycle();
      await app.start();
    }

    async function loadRomFile(file) {
      if (!file) return;
      try {
        const bytes = await readFileBytes(file);
        if (bytes.length !== 192 * 1024) {
          throw new Error("The ROM must be a 192K image (" + file.name + " is " + bytes.length + " bytes).");
        }
        const name = file.name.replace(/\.[^.]*$/, "") || file.name;
        await romLibrary.put(name, bytes).catch(function (err) { console.error("Could not keep the ROM:", err); });
        rememberRomChoice(name);
        await switchRom(bytes, name);
        await refreshRomSelect();
      } catch (err) {
        romFailure = err.message;
        romLabel = DEFAULT_ROM_NAME;
        console.error(err);
      }
      updateStatus();
    }

    async function chooseRom(name) {
      try {
        if (name) {
          const record = await romLibrary.get(name);
          if (!record) throw new Error("The ROM " + name + " is not in the library.");
          rememberRomChoice(name);
          await switchRom(record.bytes, name);
        } else {
          rememberRomChoice("");
          await switchRom(await fetchRom(), DEFAULT_ROM_NAME);
        }
      } catch (err) {
        romFailure = err.message;
        console.error(err);
      }
      await refreshRomSelect();
      updateStatus();
    }

    romSelect.addEventListener("change", function () { chooseRom(romSelect.value); });
    btnRemoveRom.addEventListener("click", async function () {
      if (!romChoice) return;
      await romLibrary.remove(romChoice);
      await chooseRom("");
    });

    romInput.addEventListener("change", function () {
      loadRomFile(romInput.files[0]).then(function () { romInput.value = ""; });
    });
    if (romNoticeLoad) romNoticeLoad.addEventListener("click", function () { romInput.click(); });
    if (romNoticeClose) {
      romNoticeClose.addEventListener("click", function () {
        romNotice.dataset.dismissed = "true";
        romNotice.hidden = true;
      });
    }

    diskInput.addEventListener("change", async function () {
      const file = diskInput.files[0];
      if (!file) return;
      try {
        // The floppy goes through the library (a new entry, or a new revision of the
        // entry with the same name) and is mounted in A:.
        const converted = PCE_STImage.toLibraryFile(file.name, await readFileBytes(file));
        const bytes = converted.bytes;
        let info;
        try {
          info = await library.addFile(converted.name, bytes, "root");
        } catch (err) {
          if (err && err.code !== "disk_library_duplicate") throw err;
          const same = library.listFiles("root").filter(function (f) { return f.name.toUpperCase() === converted.name.toUpperCase(); })[0];
          info = await library.replaceFile(same.id, converted.name, bytes);
        }
        await library.mountFile(info.id, 0);
      } catch (err) {
        console.error("Could not mount the floppy:", err);
      }
      diskInput.value = "";
      updateStatus();
    });

    btnSaveFloppy.addEventListener("click", async function () {
      const floppy = await app.flushFloppy(0);
      if (!floppy) return;
      const url = URL.createObjectURL(new Blob([floppy.bytes], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = /\.stx$/i.test(floppy.name) ? floppy.name : floppy.name.replace(/\.[^.]*$/, "") + ".st";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      updateStatus();
    });

    // ---- keyboard ----

    function pointerLocked() { return document.pointerLockElement === canvas; }
    function inputActive() { return pointerLocked() || document.activeElement === canvas; }

    document.addEventListener("keydown", function (e) {
      if (keyJoystick && KEY_JOYSTICK[e.code] && inputActive()) {
        e.preventDefault();
        if (!e.repeat) { keyPad[KEY_JOYSTICK[e.code]] = true; app.joystick(Object.assign({}, keyPad)); }
        return;
      }
      if (!inputActive() || e.repeat || !window.PCE_STKeymap.pceKeyName(e.code)) return;
      e.preventDefault();
      keyboard.setPhysicalKey(e.code, true);
      app.onKeyDown(e.code);
    });
    document.addEventListener("keyup", function (e) {
      if (keyJoystick && KEY_JOYSTICK[e.code]) {
        if (inputActive()) e.preventDefault();
        keyPad[KEY_JOYSTICK[e.code]] = false;
        app.joystick(Object.assign({}, keyPad));
        return;
      }
      if (!window.PCE_STKeymap.pceKeyName(e.code)) return;
      if (inputActive()) e.preventDefault();
      keyboard.setPhysicalKey(e.code, false);
      app.onKeyUp(e.code);
    });
    window.addEventListener("blur", function () { releaseInput(); });

    // ---- mouse (Pointer Lock) ----

    let mouseButtons = 0;

    function releaseInput() {
      app.releaseAllKeys();
      keyboard.releaseAll();
      joystick.reset();
      releaseKeyPad();
      if (mouseButtons) {
        mouseButtons = 0;
        app.mouse(0, 0, 0);
      }
    }

    function requestMouseCapture() {
      if (!app.isRunning() || pointerLocked()) return;
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(function () { canvas.requestPointerLock(); });
    }

    function syncMouseButton() {
      const locked = pointerLocked();
      btnMouse.classList.toggle("active", locked);
      btnMouse.setAttribute("aria-pressed", String(locked));
      btnMouse.title = locked ? "Mouse captured. Press Esc to release it." : "Capture the mouse for the emulated ST (Esc releases it).";
    }

    btnMouse.addEventListener("click", function () {
      if (pointerLocked()) document.exitPointerLock();
      else { focusCanvas(); requestMouseCapture(); }
    });
    canvas.addEventListener("click", function (e) {
      focusCanvas();
      if (e.pointerType === "touch") return;      // touch uses the trackpad mode below
      requestMouseCapture();
    });
    document.addEventListener("pointerlockchange", function () {
      if (!pointerLocked()) releaseInput();
      syncMouseButton();
    });
    document.addEventListener("mousemove", function (e) {
      if (pointerLocked()) app.mouse(e.movementX, e.movementY, mouseButtons);
    });
    function onMouseButton(e, down) {
      if (!pointerLocked()) return;
      const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
      if (!bit) return;
      mouseButtons = down ? (mouseButtons | bit) : (mouseButtons & ~bit);
      e.preventDefault();
      app.mouse(0, 0, mouseButtons);
    }
    document.addEventListener("mousedown", function (e) { onMouseButton(e, true); });
    document.addEventListener("mouseup", function (e) { onMouseButton(e, false); });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    // ---- touch: the screen works as a trackpad ----

    const touch = { id: null, lastX: 0, lastY: 0, startX: 0, startY: 0, startTime: 0, moved: false, longTimer: 0, rightClicked: false };

    function stRatio() {
      const rect = canvas.getBoundingClientRect();
      const video = app.getVideoSize();
      return { x: (video.width || 320) / Math.max(1, rect.width), y: (video.height || 200) / Math.max(1, rect.height) };
    }

    function syntheticClick(bit) {
      app.mouse(0, 0, bit);
      setTimeout(function () { app.mouse(0, 0, 0); }, CLICK_HOLD_MS);
    }

    canvas.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch" || touch.id !== null) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      Object.assign(touch, {
        id: e.pointerId, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY,
        startTime: performance.now(), moved: false, rightClicked: false,
      });
      touch.longTimer = setTimeout(function () {
        if (touch.id !== null && !touch.moved) { touch.rightClicked = true; syntheticClick(2); }
      }, LONG_PRESS_MS);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "touch" || e.pointerId !== touch.id) return;
      e.preventDefault();
      if (Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) > TAP_MAX_MOVE_PX) touch.moved = true;
      const r = stRatio();
      app.mouse((e.clientX - touch.lastX) * r.x, (e.clientY - touch.lastY) * r.y, 0);
      touch.lastX = e.clientX;
      touch.lastY = e.clientY;
    });
    function endTouch(e) {
      if (e.pointerType !== "touch" || e.pointerId !== touch.id) return;
      clearTimeout(touch.longTimer);
      const quick = performance.now() - touch.startTime < TAP_MAX_MS;
      if (e.type === "pointerup" && quick && !touch.moved && !touch.rightClicked) syntheticClick(1);
      touch.id = null;
    }
    canvas.addEventListener("pointerup", endTouch);
    canvas.addEventListener("pointercancel", endTouch);

    // ---- mobile tools ----

    function syncMobileToolButtons() {
      document.querySelectorAll("[data-mobile-proxy]").forEach(function (button) {
        const target = $(button.getAttribute("data-mobile-proxy"));
        if (!target || !target.classList.contains("toggle-btn")) return;
        const active = target.classList.contains("active");
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
        if (target.title) button.title = target.title;
      });
    }

    function setMobileToolsOpen(open) {
      const active = !!open;
      mobileToolsSheet.hidden = !active;
      mobileToolsButton.classList.toggle("active", active);
      mobileToolsButton.setAttribute("aria-expanded", active ? "true" : "false");
      mobileToolsButton.setAttribute("aria-label", active ? "Close mobile tools" : "Open mobile tools");
      document.body.classList.toggle("mobile-tools-open", active);
      mobilePanelBackdrop.hidden = !active;
    }

    function handleMobileProxy(targetId) {
      const target = $(targetId);
      if (!target) return;
      setMobileToolsOpen(false);
      if (target.matches("label")) {
        const input = target.querySelector("input[type=file]");
        if (input) input.click();
        return;
      }
      target.click();
      syncMobileToolButtons();
    }

    // The phone's action bar shows one input device at a time.
    function syncMobileInputButtons() {
      document.querySelectorAll("[data-mobile-input]").forEach(function (button) {
        const name = button.getAttribute("data-mobile-input");
        const active = name === "joystick" ? !joystickPanel.hidden : !keyboardPanel.hidden;
        button.classList.toggle("active", active);
        button.setAttribute("aria-label", (active ? "Hide " : "Show ") + name);
      });
    }

    document.querySelectorAll("[data-mobile-input]").forEach(function (button) {
      button.addEventListener("click", function () {
        const name = button.getAttribute("data-mobile-input");
        if (name === "joystick") {
          const show = joystickPanel.hidden;
          if (show) setKeyboardEnabled(false);
          setJoystickEnabled(show);
        } else {
          const show = keyboardPanel.hidden;
          if (show) setJoystickEnabled(false);
          setKeyboardEnabled(show);
        }
      });
    });

    mobileToolsButton.addEventListener("click", function () { setMobileToolsOpen(mobileToolsSheet.hidden); });
    mobileToolsClose.addEventListener("click", function () { setMobileToolsOpen(false); });
    mobilePanelBackdrop.addEventListener("click", function () {
      setMobileToolsOpen(false);
      if (document.body.classList.contains("mobile-panel-open")) {
        if (!diskLibraryPanel.hidden) btnDiskLibrary.click();
        if (!snapshotPanel.hidden) setSnapshotPanelVisible(false);
      }
    });
    document.querySelectorAll("[data-mobile-proxy]").forEach(function (button) {
      button.addEventListener("click", function () { handleMobileProxy(button.getAttribute("data-mobile-proxy")); });
    });

    // ---- start ----

    function cleanup() {
      if (didCleanup) return;
      didCleanup = true;
      app.dispose();
    }
    window.addEventListener("beforeunload", cleanup);

    updateStatus();
    syncMouseButton();
    syncMobileInputButtons();
    try {
      await app.ready;
      updateStatus();
      if (app.hasRom()) runPauseRequest("start", function () { return app.start(); });
    } catch (err) {
      romFailure = err.message;
      updateStatus();
    }
    return app;
  }

  window.PCE_STUI = { boot: boot };
})();
