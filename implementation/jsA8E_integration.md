# Analysis: putting the PCE core behind jsA8E's shell

Date: 2026-11-15. Source analyzed: `../A8E/jsA8E` (commit `30fb949`) and its
documentation in `../A8E/implementation/jsA8E/`. Core: PCE `b2e4b44`.
It complements `requirements.md` §5–§7; where they differ, this document wins.

> **Status update (2026-11-15).** Phase 1 and step 1 of phase 2 are done. Where
> the implementation differs from what this analysis proposed, a "Status" note
> says so (§3.1, §3.3, §6, §7, §8). `NOTES.md` is the source of truth for the
> current state.

## 1. Main conclusion

jsA8E **does not talk to the core directly**. The whole shell (UI, proxy,
library, sync, automation, MCP) reaches the emulator through a single seam:

```text
ui.js / automation_api.js
        │  (proxy API, ~70 methods)
   app_proxy.js ──postMessage/RPC──► emulator_worker.js
                                            │
                                   A8EApp.create(opts)   ← js/core/atari.js (1685 lines)
                                            │
                                   cpu / antic / gtia / pokey / memory ...
```

The worker calls `A8EApp.create({canvas, gl, audioEnabled, turbo, ...})` and the
rest of the site only knows the methods it returns (`start`, `pause`, `reset`,
`loadDiskToDeviceSlot`, `onKeyDown`, `saveSnapshot`, `readRange`,
`captureScreenshot`, `getDebugState`, ...). **The central job is to write a
`STApp` with that same shape, backed by PCE's WASM.** Everything above it is
reused, pruning what is specific to the 8-bit Atari.

This confirms option A (WASM) and refines it: PCE's `main()` and its browser loop
do not need to be adapted. PCE has to be built as a **library** with our own C
glue layer (`st_glue.c`) and the loop driven from the worker, as jsA8E does with
its own core.

## 2. What is reused, what is adapted, what is built

jsA8E sizes: `ui.js` 3602, `app_proxy.js` 2326, `automation_api.js` 2216,
`disk_library.js` 2001, `disk_library_ui.js` 1359, `index.html` 992,
`style.css` 4605, `emulator_worker.js` 1366.

### Reused almost as is (just rename and prune)

- **Library**: `disk_library.js` is generic (entries, revisions, folders, trash,
  tombstones, hashes). It only assumes ATR in `isSupportedName` (`atr|xex`),
  `createBlankAtrBytes` and the default extension. `library_package.js`,
  `library_archive.js` and the remote sync (`remote_*`) do not depend on the
  format.
- **Worker/proxy/RPC**: the protocol, the timeouts, buffer transport and the
  fall-back to no-worker mode. The VBXE, printer and SIO messages are removed.
- **Automation/MCP/headless**: the grouped API (`system`, `media`, `input`,
  `debug`, `dev`, `artifacts`, `events`). `headless.js` loads the core in a Node
  `vm`; the ST equivalent loads the WASM in Node (already proven in phase 0).
- **Gamepad, snapshots (container), themes, panels, mobile, Tauri.**
- **Audio**: the worklet is a sample queue; only who produces the samples
  changes.
- **CRT shader** (`webgl*.crt.frag.glsl`, ~190 lines each).

### Adapted

| Piece | Change |
|---|---|
| `index.html`, `ui.js` | Remove the 8-bit controls (see §4) and add the ST's. Coupling measured in `ui.js`: SIO 48 mentions, VBXE 32, BASIC 23, HostFS 19, PAL/NTSC 8. It is pruning, not a rewrite. |
| `disk_library*.js`, `disk_image.js` | `.st/.msa/.dim` formats, ST floppy geometry, blank 720K floppy. `disk_library_ui.js` has 89 mentions of ATR. |
| `render/gl.js`, decode shaders | Today the decode is an **8-bit index → 256-entry palette**, with fixed `VIEW_W=336`, `VIEW_H=240`. The ST delivers **variable-size RGB24** (640×400 mono, 320×200 and 640×200 color). It has to move to a direct RGB texture and dynamic size; the CRT pass is reused. |
| Audio | `audio/runtime.js` is tied to POKEY (SIO active, turbo). The worklet is kept and its input rewritten. |
| Input | `keys.js`/`input.js` map to the 8-bit Atari keyboard. They are rewritten for ST codes and a mouse is added. |
| `rom_library.js` | Goes from OS/BASIC to TOS/EmuTOS (192K). |

### Built from scratch

1. **`STApp`** (adapter with `A8EApp`'s API) and its C glue.
2. **Mouse input** (jsA8E barely has any).
3. **PCE's video/sound/input towards JS** (replacing SDL).
4. **Snapshots** (PCE does not serialize state; see §3.4).
5. **HostFS/XEX equivalents** (see §5).
6. 68000 debugger and disassembler (late phase).

## 3. Core design

### 3.1 PCE already has the abstractions we need

PCE does not have to be rewritten, only a couple of drivers and some glue:

- **Video**: `terminal_t` (`drivers/video/terminal.h`) holds `buf` (RGB, 3 bytes
  per pixel), `w`, `h` and the `update_*` rectangle. A `js` driver (instead of
  `sdl.c`) only has to leave that buffer readable from JS: **zero copy** by
  looking at `HEAPU8`.
- **Input**: `trm_set_key(trm, event, pce_key_t)` and the `set_mouse
  (dx, dy, buttons)` callback. C functions are exported for JS to call.
- **Sound**: `sound_drv_t.write(buf, cnt)` receives `uint16` samples. A `js`
  driver pushes that block to the worklet.
- **Media**: PCE uses messages (`emu.fdc.ro`, `disk.insert`, `disk.eject`,
  `disk.commit`, ...) on images in its file system. JS writes the bytes into
  Emscripten's FS and sends the message.
- **Clock**: `st_clock(sim, n)` advances cycles. `st_step_cycles(n)` /
  `st_step_frame()` are exported and the worker decides the pace.

> **Status:** implemented more simply. PCE's `null` terminal already keeps the
> RGB buffer, so no `js` video driver was needed; for audio the PSG driver's
> `write` is replaced from the glue. See `CORE_API.md`.

### 3.2 Loop and determinism

PCE's `st_run_emscripten_step` uses the browser's real time. Instead, the worker
calls `st_step_frame()` with exact cycles (as jsA8E does with
`CYCLES_PER_FRAME`). This also solves risk 3 of `requirements.md` (deterministic
tests, golden traces) and the turbo mode.

### 3.3 Building as a library

Build with `MODULARIZE`, `EXPORT_NAME`, `EXPORTED_FUNCTIONS` and **without** a
main loop or `main()`. The dependency on `-DEMSCRIPTEN`, on `-sUSE_SDL` and on
`em_sdl_extra.js` goes away. Changes to PCE must live as patches or as our own
files (`core/`), not in the clone.

> **Status:** done (`scripts/build-core.sh`, `core/st_glue.c`). `-DEMSCRIPTEN` is
> still passed, only for PCE's `sysdep.c`; SDL and `em_sdl_extra.js` are gone.

### 3.4 Snapshots: WASM memory dump (confirmed in phase 1)

PCE has no state serialization (there are no `save_state` functions in the CPU,
MFP, FDC, etc.). Rewriting it for ~10 devices is a lot of work. Hypothesis to
validate in the prototype: **all the state lives in the WASM linear memory**
(heap and globals), so dumping and restoring that memory (compressed) reproduces
the emulator's exact state. Conditions to check:

- There are no pointers to the outside that get invalidated (file descriptors,
  references to JS).
- The function table is stable for the same module.
- Disk files in Emscripten's FS are saved separately.
- Size (initially ≈16 MB with the current configuration) and compression cost.

**Result (2026-11-15): it holds** (see `NOTES.md`, "Snapshots: hypothesis
confirmed"). `saveSnapshot/loadSnapshot` of the contract are implemented with
little code and the `snapshot_codec.js` container is reused.

## 4. Interface controls

jsA8E's toolbar: Start/Pause, Reset, Audio, Option-on-Start, CRT, full screen
(2), Turbo, SIO Turbo, Joystick, Keyboard, Keyboard map, HostFS, Library,
Assembler, Printer, Snapshots, three layouts (Emulation / Work / Development),
clear ROMs.

| Control | On the ST |
|---|---|
| Start/Pause, Reset, Audio, CRT, full screen, Turbo, Joystick, Keyboard, Library, Snapshots, layouts | Kept |
| Option-on-Start, SIO Turbo, console buttons (START/SELECT/OPTION), PAL/NTSC, VBXE, memory expansion, printer, OS/BASIC ROM notice | **Removed** |
| Assembler | Removed (later phase: 68000) |
| HostFS | Deferred (§5) |
| Translated/original keyboard map | Review: the ST has its own keyboard |
| — | **New**: mouse capture, mono/color monitor, model (ST/Mega), RAM, TOS/EmuTOS ROM notice |

## 5. Gaps with no direct equivalent

- **XEX/H:**. jsA8E boots loose executables and has an `H:` device with working
  files. On the ST the equivalent would be `.PRG`, but PCE only sees disks.
  Options: (a) build a FAT12/FAT16 image in JS with the uploaded files and mount
  it; (b) defer. The workspace and the content inspector depend on this (the
  equivalent of `atr_inspector.js` would be a FAT12 reader).
- **Debugger**: jsA8E's is 6502 (890 lines). PCE has `disasm.c` and access to
  registers (`e68_get_*`) and memory; they have to be exposed and the debugging
  UI rewritten.
- **Slot mapping**: the API uses "device slots" (D1–D8). They are reinterpreted
  as A:, B: and ACSI disks.

## 6. Phase plan (revised)

0. **Done**: build and boot of EmuTOS (`NOTES.md`).
1. **Core as a library**: C glue, `js` video/sound/input drivers,
   `st_step_frame()`, exports; tested in Node (determinism, frame dumps, state
   hash) **before** touching the browser. **Done.**
2. **`STApp` and minimal shell**: copy the shell, prune, `STApp` behind the
   worker, RGB rendering, audio and input (including mouse). Memory-dump snapshot
   test. *Step 1 (minimal page in the browser) and step 2 (the shell's frame with
   `PCE_STApp` and the emulation controls) are done; see `NOTES.md`. The
   library, panels and automation are steps 3 and 4.*
3. **Library and media**: ST formats, floppies and ACSI, revisions and sync.
4. **Automation/MCP/headless** and a deterministic test net.
5. **HostFS/PRG (FAT)**, 68000 debugger.
6. **Mac Plus** (later).

It is possible to stop after phase 2 with a usable emulator that looks like
jsA8E.

## 7. Decisions needed from the user

> **Status:** 1–4 are resolved (see "Decisions made" in `NOTES.md`).

1. **Copy or share the shell.** Copy = the project is independent (in line with
   "separate product"), but the shell will drift away from jsA8E and improvements
   will not be shared. Alternative: extract a common part. Recommendation:
   **copy** and record the origin commit. *Resolved: copy.*
2. **Prefix and names.** jsA8E uses `window.A8E*`, `a8e_disk_library`,
   `A8EAutomation`. The product name has to be set (open question in
   `requirements.md`) before copying. *Resolved: prefix `PCE_ST`.*
3. **Worker loop with exact cycles** (§3.2) instead of PCE's loop: recommended.
   *Resolved: yes.*
4. **Snapshot strategy** (§3.4): try the WASM memory dump first. *Resolved: it
   works.*
5. The already-open questions: hardware references, ST/STE/Mega, relative or
   absolute mouse, Tauri and mobile, default ROM. *Mouse, default ROM and
   language resolved; the rest in "Still to decide" in `NOTES.md`.*

## 8. New or refined risks

- Variable-size video: the renderer, the aspect ratio and the page layout assume
  336×240. The ST monitor does not have square pixels.
- PCE's audio is designed to synchronize with the host's clock; with an exact-cycle
  loop it has to be decided how the worklet is fed (queue and overflow control)
  and what happens with turbo. *Resolved in step 1: the glue pads to emulated
  time and the worklet manages the queue; at speeds other than 1× the audio is
  discarded.*
- Pruning `ui.js` (3602 lines) is the biggest job of the shell: it is best done
  guided by smoke tests so the layout does not break.
- Joystick and gamepad: how PCE exposes the IKBD joystick to the terminal layer
  was not checked; it has to be verified. *Still pending.*
- If the hypothesis in §3.4 failed, snapshots would become the project's largest
  cost. *It did not fail.*
