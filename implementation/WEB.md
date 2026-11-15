# Web page: architecture, API and protocols

The page (`web/`) is the shell of the emulator: the jsA8E look and feel (toolbar,
themes, CRT screen, mobile tools) driving the ST core. This document covers how it
is built. For what was taken from jsA8E and what was left out, see
"Copied from jsA8E" in `NOTES.md`.

## File map

```text
web/
  index.html               page structure (toolbar, screen, mobile tools, ROM notice)
  style.css                styles (from jsA8E, plus a few PCE_ST additions at the end)
  emulator_worker.js       worker: message dispatcher around PCE_STApp
  js/
    app/ui.js              user interface (PCE_STUI.boot)
    app/keyboard.js        on-screen Atari ST keyboard (PCE_STKeyboard)
    app/joystick.js        on-screen joystick logic (PCE_STJoystick)
    app/gamepad.js         physical gamepad polling (PCE_STGamepad)
    app/snapshot_ui.js     snapshot panel (PCE_STSnapshotUI)
    app/disk_library_ui.js floppy library panel (PCE_STDiskLibraryUI)
    app/pce_st.js          entry point
    core/app_proxy.js      main-thread side of the machine (PCE_STAppProxy)
    core/st_app.js         the machine inside the worker (PCE_STApp)
    core/keymap.js         KeyboardEvent.code -> PCE key names
    core/disk_library.js   floppy library (IndexedDB), library_package.js, library_archive.js
    core/rom_library.js    ROM library (IndexedDB, PCE_STRomLibrary)
    core/snapshot_codec.js snapshot file container (PCE_STSnapshot)
    core/st_image.js       FAT12 floppy builder and verifier (PCE_STImage)
    render/gl.js           WebGL2 renderer with the CRT filter (PCE_STGlRenderer)
    render/software.js     Canvas 2D fallback renderer
    render/shaders/        vert.glsl, decode.frag.glsl, crt.frag.glsl
    audio/worklet.js       AudioWorklet queue (pce-st-audio)
  assets/leds.png          sprite used by the status LEDs
  vendor/fontawesome/      Font Awesome Free 6.5.1 (icons), served locally
  vendor/fonts/            Exo 2 and Roboto Condensed (Latin subsets), served locally
```

Nothing is loaded from the network: icons and fonts are vendored (licenses in
`NOTICE.md`).

## Overview

```text
Main thread                                   Worker (emulator_worker.js)
  ui.js  ──►  PCE_STAppProxy  ── postMessage ──►  PCE_STApp ──► pce_st_core (WASM)
   │            (app_proxy.js)  ◄── events ─────   (st_app.js)     │
   │  AudioContext + worklet ◄──── MessagePort (Int16Array) ──────┘
   └─ <canvas> ──transferControlToOffscreen──► WebGL2 / Canvas 2D renderer
```

- Emulation, video drawing and the audio feed happen **in the worker**. The
  `<canvas>` is handed over once with `transferControlToOffscreen()`; after that
  the main thread can only size it with CSS and tell the worker the pixel size
  (`setRenderSize`).
- The main thread keeps a **synchronous mirror** of the machine state, so the UI
  reads it without round trips; everything else is a request with a timeout.
- Audio goes through a `MessageChannel`: one end to the worklet (message
  `{port}`), the other to the worker (`audioPort` message). Samples never touch
  the main thread.
- The `.wasm` is located with `locateFile` (`../build/out/`).

## `PCE_STApp` (worker side, `st_app.js`)

`await PCE_STApp.create({ canvas, audioPort, rom, config, crtEnabled, audioEnabled, turbo, onEvent })`
returns the machine. Events (`onEvent`): `{type: "state", state}`,
`{type: "stats", stats}`, `{type: "log", text}`.

| Method | Description |
|---|---|
| `start()` / `pause()` / `isRunning()` / `isReady()` | Run control. `start` needs a ROM. |
| `reset()` | Hardware reset (RAM is kept, like the ST's reset button). |
| `powerCycle()` | A brand-new machine: RAM is cleared; floppies stay in their drives (their changes are saved first). The toolbar's reset button uses this. |
| `configure({mono, ramKB, model})` | New hardware; it restarts the machine. |
| `loadRom(bytes)` / `hasRom()` | ROM image (192K); it takes effect at the next power cycle. |
| `setTurbo(on)` / `getTurbo()` | Maximum speed. Audio is muted while it is on. |
| `setAudioEnabled(on)` / `setCrtEnabled(on)` / `setRenderSize(w, h)` | Output settings. |
| `onKeyDown(code)` / `onKeyUp(code)` | Keyboard (`KeyboardEvent.code`; unmapped codes are ignored). |
| `mouse(dx, dy, buttons)` | Relative motion; buttons: bit 0 left, 1 right, 2 middle. |
| `setJoystickEnabled(on)` / `getJoystickEnabled()` | Joystick mode (port 1): the numeric-keypad keys then belong to the joystick. Kept across power cycles. |
| `joystick({up, down, left, right, fire})` | Sets the stick and fire button (missing = released); only changes are sent. Ignored while the mode is off, so digits are never typed by accident. |
| `getJoystickState()` | `{enabled, port1}`: the IKBD's state of port 1 (bit 0 up, 1 down, 2 left, 3 right, 7 fire). |
| `mountFloppy(drive, bytes, name)` / `unmountFloppy(drive)` / `flushFloppy(drive)` | A: = 0, B: = 1. `flushFloppy` saves the guest's changes and returns `{name, bytes}`. |
| `saveSnapshot()` / `loadSnapshot(snap)` | Full machine state by dumping WASM memory (see `CORE_API.md`). |
| `readMemory(addr, len)` / `writeMemory(addr, bytes)` / `getRegisters()` | Debugging. `writeMemory` accepts a `Uint8Array`, an `ArrayBuffer` or an array of bytes. |
| `stepFrames(n)` / `getStateHash()` / `captureScreenshot()` / `getCounters()` | Automation: deterministic stepping while paused, state digest, `{width, height, rgb}`, clock/frames. |
| `getState()` | `{ready, running, turbo, audioEnabled, joystick, crtEnabled, romLoaded, config, video, backend, floppies}` |

`PCE_STAppProxy` (main thread, `app_proxy.js`) exposes the same method names; the
ones that return data return promises. Extra members: `ready` (promise),
`onStateChange/onStats/onLog/onError`, and synchronous getters (`getState`,
`getVideoSize`, `getStats`, `hasMountedFloppy`, `getFloppyInfo`,
`getAudioStatus`, ...). `window.PCE_ST_APP` is the live proxy (used by tests and
the future automation API).

## Run loop

On every tick (`setTimeout(…, 1)`):

1. `dt` = real time since the previous tick, capped at **100 ms** (as in PCE;
   avoids the catch-up spiral).
2. Normal speed: `budgetMs += dt`; while `budgetMs > 0`, call
   `pce_st_step_frame()` and subtract that frame's emulated time. A tick that
   takes more than 50 ms of work is cut short; leftover budget over 200 ms is
   discarded.
3. Turbo: advance frames for 12 ms of work.
4. Draw the last frame if it is new, send the audio (not in turbo, not when muted)
   and, every 500 ms, emit `stats` (`fps`, `speed`, `clock`).

**Painting is decoupled from emulation.** At normal speed every new frame is
drawn; in turbo the picture is refreshed at most every 100 ms, because a
CRT-filtered frame costs more than emulating it (measured with software WebGL:
without this, turbo was no faster than real time).

## Rendering

- **WebGL2** (`gl.js`), two passes, as in jsA8E: *decode* draws the ST's RGB
  frame (uploaded as an `RGB8` texture, no conversion in JS) into an offscreen
  scene texture at 2x horizontal oversampling; *CRT* post-processes it to the
  canvas (barrel warp, scanlines, shadow mask, vignette, rounded tube corners;
  shader by Timothy Lottes, adapted). With the filter off, the frame is drawn
  straight to the canvas with nearest-neighbor sampling.
- The **source size can change at any time** (640×400 mono, 320×200 or 640×200
  color): textures are rebuilt on the fly.
- **Canvas 2D** (`software.js`) is the fallback when WebGL2 is unavailable
  (no CRT filter).
- The page sizes the canvas in CSS at a **4:3** aspect (the ST's monitors) and
  tells the worker the physical pixel size (`css size × devicePixelRatio`), so
  the filter works at the display's real resolution.
- The CRT shader is the jsA8E one, which includes a composite-video color
  bleeding stage. The ST normally used RGB or monochrome monitors; whether to
  switch that stage off is a pending visual decision.

## Audio

Same as before: `audio/worklet.js` is a queue of mono `Int16` samples (2^17
slots, ~2.7 s). It starts with **40 ms** accumulated; if it runs dry it plays
silence, counts an *underrun* and waits for 40 ms again; if it exceeds
**250 ms** it drops the oldest samples down to **80 ms** (`dropped`). Every
0.5 s it reports `{queued, underruns, dropped, peak}` (`peak`: maximum absolute
value played since the last report; 0 = exact silence). The proxy creates the
`AudioContext` on the first `start()` and resumes it on the first user gesture.

## Input

- **Keyboard**: `keydown/keyup` with `event.code`; repeats are ignored (the ST
  repeats in software); `preventDefault` only for mapped keys. Active while the
  screen has focus or the mouse is captured. Losing focus or releasing the mouse
  releases every pressed key and button.
- **Mouse**: clicking the screen (or the mouse button in the toolbar) requests
  Pointer Lock (`unadjustedMovement` when available); `movementX/Y` and the
  buttons are sent to the machine; `Esc` releases the pointer. The context menu
  is disabled on the screen.
- **On-screen keyboard** (`keyboard.js`): generated from a layout table onto a CSS
  grid of 46 columns (main block 30, cursor cluster 6, numeric keypad 8). Each key
  carries a `KeyboardEvent.code`, so it goes through the same path as the physical
  keyboard. Two-tone keycaps (light for characters, dark for function/control keys)
  on a warm grey case; sizes follow the panel's own width (container query units).
  Below 700 px the keypad is dropped and the panel scrolls sideways rather than
  shrinking the keys further. **Modifiers** (Shift, Control, Alternate): one tap
  holds the key until the next ordinary key is released, a double tap (within
  350 ms) locks it, a tap unlocks it; hiding the panel releases everything. Several
  keys can be held at once (each pointer is tracked). Keys pressed on the physical
  keyboard are highlighted. The `(` and `)` keys exist on the ST but have no PCE
  key code, so they are drawn disabled.
- **On-screen joystick** (`joystick.js`): the CX40 markup and styles of jsA8E; a
  draggable stick (20 px deflection, 10 px dead zone) and a fire button report
  `{up, down, left, right, fire}` to `app.joystick()`. Showing the panel turns the
  joystick mode on, hiding it turns it off.
- **Touch**: the screen works as a **trackpad**. Dragging moves the cursor (deltas
  scaled from CSS pixels to ST pixels); a short, still touch is a left click; a
  long press (500 ms) without moving is a right click. (`pointerType: "touch"`;
  `touch-action: none` on the canvas.)

## User interface (`ui.js`)

- **Toolbar**: run/pause, reset (power cycle), audio, ROM, open floppy in A:,
  save floppy A:, CRT, display fullscreen, workspace fullscreen, turbo, mouse
  capture, and a collapsible row with **Monitor** (mono/color), **Memory**
  (512K, 1 MB, 2 MB, 4 MB) and **Theme** (CyberDeck, 800XL, XEGS, 65XE/130XE,
  400/800, **Atari ST** by default, 2600). Changing monitor or memory restarts
  the machine.
- **ROM**: EmuTOS is loaded from `roms/emutos/`. The ROM button loads another
  192K image (other sizes are rejected), keeps it in the ROM library (IndexedDB)
  and restarts. The **ROM** selector (secondary row) switches between EmuTOS and
  the stored ROMs, and a trash button removes the selected one. If no ROM can be
  loaded, a notice asks for one.
- **Floppy**: the open button adds a `.st`/`.prg` to the library and mounts it in A:; the save button flushes it and
  downloads `<name>.st`.
- **Status line** (bottom left of the screen): `Paused ·` when paused, fps,
  speed relative to real time, and the video size.
- **Mobile**: below 980 px wide the action bar (Joystick, Keyboard, More) and a
  tools sheet (CRT, turbo, fullscreen, machine settings, ROM, floppy, save)
  replace the toolbar's secondary controls. The action bar shows one input device
  at a time.
- **Layouts**: two buttons next to the toolbar select the scheme. *Emulation* (the
  default) shows only the screen; *Work* puts the floppy library in a left column
  next to the screen, with a draggable splitter (arrow keys also resize it; the
  ratio is remembered). The library button shows or hides the panel in either
  scheme. On a phone the panel is a full-screen sheet with a backdrop, opened from
  the tools sheet ("Library").
- **Floppy library panel**: mounted devices (A:/B:), upload and drag-and-drop of
  `.st`/`.prg`, new folder, new blank 720K floppy, select/download/delete
  selected, recoverable trash (purge all or older than a date), search with type,
  status and sort filters, per-file verify, download, move, revisions and delete,
  and export/import of `.pcest` packages. The library is `window.PCE_ST_LIBRARY`
  (see `LIBRARY.md`). A *View the files* button opens a read-only FAT12 view
  (folders, preview, per-file download). `.msa` files are converted to `.st` when
  added. Remote sync (WebDAV) is in the title bar; two buttons build a floppy from files or
  from a folder.
- **Snapshots panel** (camera button): *Quick slot* save/restore (IndexedDB
  `pce_st_snapshots`) and export/import of `.pcestsnap` files. A snapshot holds the
  whole WASM memory (deflate-compressed, ~240 KB), the machine configuration and
  the floppies in A:/B:; it does **not** hold the ROM, so restoring needs the ROM it
  was taken with (the name is checked and a mismatch is explained). After a restore
  the monitor/memory selectors follow the snapshot and no library entry counts as
  mounted (the machine holds the snapshot's floppies; nothing is written back to
  the library until a floppy is mounted from it again).
- **Gamepad**: any connected pad (Gamepad API, standard mapping or plain axes)
  drives the joystick: left stick or d-pad for directions, any face button fires.
  Using a pad turns the machine's joystick mode on even if the on-screen joystick
  is hidden (the numeric keypad then stops typing digits).
- **Preferences** (`localStorage`): `pce_st_ui_theme`, `pce_st_crt_enabled`,
  `pce_st_monitor`, `pce_st_ram_kb`, `pce_st_layout_scheme`,
  `pce_st_layout_column_ratio`, `pce_st_rom_choice`. The library itself is in IndexedDB.
- **URL options**: `?crt=0` / `?crt=1` forces the CRT filter for that session
  without storing it.

## Server (`scripts/serve.js`)

Static server without dependencies, on `127.0.0.1` only. It serves just
`/web/`, `/core/st_config.js`, `/build/out/` and `/roms/` (anything else returns
404; protected against paths with `..`). Correct MIME types for `.wasm`.
Headers `Cache-Control: no-store` and `Cross-Origin-Opener-Policy`/
`Embedder-Policy`/`Resource-Policy` (they leave the page isolated, needed later
for `SharedArrayBuffer`). It can be imported
(`require("./scripts/serve.js").start(0)` returns the server on a free port).

## Browser tests (`tests/browser/`)

`cdp.js` is a minimal client for Chrome's DevTools protocol, with no
dependencies (hand-written WebSocket): it launches headless Chrome in its own
process group (closing kills every helper process), opens pages, evaluates JS,
sends keyboard, mouse and **touch** events, emulates a viewport and takes
screenshots. `browser.test.js` covers: real time and audio, the English UI,
pause, turbo, the real keyboard, end-to-end audio (silence, tone, silence),
muting, the CRT filter, hardware selectors (monitor and memory, checked against
TOS's own `phystop`), floppy and ROM file selectors, theme, snapshots, pointer
capture and mouse motion, the on-screen keyboard (key map, clicking a key,
modifier behavior, physical-key highlight), the on-screen joystick (stick, fire,
restart), touch trackpad, the mobile tools and input bar, and the ROM notice.

Known traps when writing tests:

- A freshly created video buffer is **all black**: "many dark pixels" is not
  enough to say the desktop is drawn (it is dotted, ~48 % dark).
- The desktop takes ~18 emulated seconds: use turbo, then go back to 1×.
- **Headless Chrome renders WebGL in software**, where the CRT filter dominates the
  cost. Tests open pages with `?crt=0` unless they test the filter.
- Preferences persist between pages of the same origin: the test client clears a
  page's `localStorage` when it closes it.
- Key presses must last several frames (≥ 80 ms) for GEM to see them; GEM selects
  on mouse button **release**.
- A loaded machine makes timing assertions flaky: thresholds (audio underruns,
  frame rate) are deliberately loose.
