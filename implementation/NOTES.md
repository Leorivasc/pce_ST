# pce_ST — Implementation notes

Read before planning; update after every improvement. The project's context and
requirements are in `../requirements.md`.

**Project language: English.** Documentation, UI text (menus, buttons, labels),
on-screen and error messages, code comments and test names are all in English.
Conversations about the project may be in any language, but what goes into the
repository is English. (Decision of 2026-11-15; see "Decisions made".)

## Status

- Phase 0 (audit and build): **done** (2026-11-15).
- Phase 1 (core as a library, tested in Node): **done** (2026-11-15).
  To close it completely the WASM still had to be tested in a real browser
  (done in phase 2, step 1).
- Phase 2, **step 1** (minimal skeleton in the browser): **done** (2026-11-15).
  `web/` page with a worker, video on an OffscreenCanvas, audio through an
  AudioWorklet and keyboard and mouse input (Pointer Lock), tested in real
  Chrome.
- Phase 2, step 2 (copy and prune jsA8E's shell, `PCE_STApp`): pending.
- Phase 2, step 3 (media and library): pending.

## How to build and test the core

Requirements: `emsdk` in `~/emsdk` (or `EMSDK_DIR`), a clone of
<https://github.com/Leorivasc/pce> in `~/Documents/GIT/pce` (or `PCE_SRC`),
Node, Python 3, make.

```bash
scripts/build-core.sh                              # ~30 s -> build/out/
node tests/core/core.test.js                       # 14 tests, ~35 s
node tests/browser/browser.test.js                 # 9 tests in real Chrome, ~45 s
node scripts/serve.js [port]                       # the page at http://127.0.0.1:8080/
node tests/core/core.test.js --only=floppy         # a single test
node tests/core/core.test.js /other/rom.img        # with another ROM
```

- Output: `build/out/pce_st_core.js` (`MODULARIZE` module, factory
  `PCE_STCoreFactory`) and `pce_st_core.wasm` (~360 KB). The JS loads the `.wasm`
  by name. `build/` is in `.gitignore`.
- The script builds a clean copy (`git archive`) and **does not touch the PCE
  clone**. There are no patches on PCE: all of the project's own code is in
  `core/`.
- Tested versions: Emscripten **7.0.0**, PCE `b2e4b44`, Node 18.19.1,
  Python 3.12, EmuTOS 1.4.
- **Default ROM included**: `roms/emutos/etos192us.img` (EmuTOS 1.4, 192 KB, US,
  GPL) with its license, authors, SHA-256 and source link in
  `roms/emutos/README.md`. Atari TOS ROMs are not included (copyrighted); if the
  user wants to use them, the user supplies them.
- Each module instance has its own memory: the tests create several in the same
  process.

## Core architecture (phase 1)

`core/st_glue.c` **replaces PCE's `src/arch/atarist/main.c`** (which is not
linked). The rest of PCE's objects (68000 CPU, chipset, drivers) are linked as
they are, without SDL (`--without-sdl`) and without a main loop (`--no-entry`).
The script gets the object list from PCE's own Makefile (`PCE_ATARIST_OBJ` and
`PCE_ATARIST_OBJ_EXT`). The exported functions are all `pce_st_*` and are
detected automatically from `core/st_glue.c`.

| Area | How it is solved |
|---|---|
| Video | PCE's `null` terminal: it already maintains `trm->buf` (RGB, 3 bytes per pixel), `w` and `h`. JS reads that buffer directly (`pce_st_video_buf/width/height`). The size changes by itself (640×400 mono, 320×200 color). |
| Audio | `st_psg_get_driver()->write` is replaced by our own queue. See finding 6. |
| Input | `trm_set_key(event, pce_key_t)` and `trm_set_mouse(dx, dy, buttons)`; `pce_st_key_from_name("a")` converts names to codes. Event 1 = press, 2 = release. Buttons: bit 0 left, bit 1 right, bit 2 middle. |
| Media | JS writes the image into Emscripten's FS and sends `disk.eject <n>` + `disk.insert <path>` (`pce_st_msg`). `pce_st_disk_flush(n)` saves the image **without ejecting**. |
| Loop | `pce_st_step_frame()` (until a video frame is complete) and `pce_st_step_cycles(n)` (multiples of 16; 8 000 000 per second). The worker decides the pace. |
| State | `pce_st_peek8/poke8`, `pce_st_reg("pc")`, `pce_st_state_hash()` (FNV-1a of RAM, registers, clock and video). |
| Time | `pce_st_set_time(seconds)` fixes the RTC/IKBD time; from then on it advances only with emulated time and `localtime` returns UTC. It is linked with `--wrap=time --wrap=localtime`. A negative value uses the real time. |

## Findings

### Build (phase 0)

1. **`EMSCRIPTEN` is no longer defined**; only `__EMSCRIPTEN__`. PCE's
   `sysdep.c` uses `#ifdef EMSCRIPTEN` (no sleeping, no real-time sync), which
   is why the script passes `-DEMSCRIPTEN`. Without it, PCE's `main()` starts the
   **interactive monitor** and waits on stdin (no longer applicable: its `main`
   is not used).
2. The `pcejs_build*` scripts do not work with Emscripten 7: obsolete flags
   (`ASM_JS`, `TOTAL_MEMORY`, `--source-map-base`, `MEM_INIT_METHOD`).
   `libjs/library_sdl.js` does not compile ("Internal compiler error JS
   compiler").
3. Emscripten's built-in SDL1 does not cover PCE: `SDL_EventState` is missing and
   the video comes out blank (`SDL_CreateRGBSurfaceFrom` with 24 bits is only
   implemented for 32). **That is why SDL was removed entirely** (see above).
4. With Emscripten 7.0.0 the 1.38.48 SDK from PCE.js's README is not needed;
   `./configure` works with Node 18. PCE's scripts call `python`: the script
   creates `build/bin/python -> python3`.

### Core (phase 1)

5. **EmuTOS boot is long**: the complete desktop appears at ~18 emulated seconds
   in both monochrome (frame ~1270, 71 Hz) and color (frame ~1070, 60 Hz),
   because of the floppy time-outs. During that time you see the message
   "EmuTOS Version 1.4", then a blank screen and finally the hourglass. With the
   emulated CPU about 8 times faster than real time, boot takes ~2.3 s of wall
   clock (a boot turbo is possible).
6. **PCE's PSG silences itself** (`silence_cnt == 0`) and delivers blocks of 512
   samples, so its stream has gaps. The glue pads with zeros up to
   `cycles × rate / 8 MHz` at the end of every step, so `audio_total` always
   follows emulated time (test: ±1 sample). Samples are signed `int16`, mono, at
   `psg.sample_rate` (48000).
7. **Non-deterministic by default**: `rp5c15.c` and `ikbd.c` read the host's
   `time()` and `localtime()`. Solved with the fixed time above. `rand()` is used
   in `wd179x.c` and `blkpsi.c` but PCE never calls `pce_srand`, so it is
   deterministic.
8. **Floppies are saved only on eject or reset** (PCE decodes the image into
   tracks in memory and `st_fdc_save` writes it to the file). That is why
   `pce_st_disk_flush` exists. `disk.commit` alone is not enough.
9. **GEM selects when the mouse button is released**, not when pressed. In tests
   you have to wait ~30 frames after releasing.
10. Writing to an emulated floppy is slow (a new folder takes ~1200 frames to
    finish).

### Snapshots: hypothesis confirmed

Dumping the **whole WASM linear memory** (`Module.HEAPU8`, 17 MB, 240 KB with
deflate level 1, ~42 ms) and restoring it into another instance reproduces the
exact state: same hash and same subsequent execution ("snapshot" test). There is
no need to serialize PCE's devices one by one. Conditions:

- The target instance must have been **initialized with the same configuration**
  (same memory layout); the `HEAPU8` size must match.
- What lives in JS's file system (mounted floppy images) **is not in WASM
  memory**: those files must be recreated at the same paths before restoring.
  The track image is in memory.
- If memory has grown (`ALLOW_MEMORY_GROWTH`) the size must be equalized before
  copying; a case with growth has not been tested yet.

## Browser (step 1)

Full reference for the protocol and the debugging API: `WEB.md`. Summary:

Files in `web/`: `index.html`, `main.js` (main thread), `worker.js` (emulation),
`audio-worklet.js`, `keymap.js`. `core/st_config.js` generates the core's
configuration text and is shared by Node and the worker. `scripts/serve.js` is a
static server without dependencies that only serves `/web/`,
`/core/st_config.js`, `/build/out/` and `/roms/`, with COOP/COEP headers.

- **Loop**: the worker accumulates real time (`budgetMs += dt × speed`, capped at
  100 ms per tick like PCE) and calls `pce_st_step_frame()` while budget remains.
  Speed 1×/2×/4× or maximum (12 ms batches of work).
- **Video**: the worker converts RGB→RGBA and draws with `putImageData` on an
  `OffscreenCanvas` (`transferControlToOffscreen`). The main thread **cannot read
  that canvas**; for tests there is `PCE_ST_DEBUG.screenshot()` (the worker
  returns the RGB buffer).
- **Audio**: the worker sends `Int16Array` through a `MessagePort` straight to
  the `AudioWorklet` (queue of ~2.7 s; starts with 40 ms accumulated; trims to
  80 ms if it exceeds 250 ms; outputs silence if it runs dry). The worklet
  reports queue, underruns, drops and peak every 0.5 s.
- **Input**: `keydown/keyup` with `event.code` → PCE name (`web/keymap.js`) →
  `pce_st_key_from_name`. Mouse: Pointer Lock, `movementX/Y` and buttons (bit 0
  left, 1 right, 2 middle).
- **Debugging**: `window.PCE_ST_DEBUG` (`state()`, `send()`, `screenshot()`,
  `peek()`, `readFloppy()`). The worker also accepts `poke` and `peek`.

### Step 1 findings

11. **PSG audio is unsigned with zero at `0x8000`**
    (`psg_add_sample`: `smp = 0x8000 + voltab/4`). The glue does
    `(int16_t)(s ^ 0x8000)`. Reading it as `int16` gave `-32768` in silence and,
    together with the zero padding, full-scale clicks. It was detected because the
    worklet measured a peak of 1.0 during boot. Now rest is exactly 0 and the tone
    is centered (mean ≈ 0, ±7000).
12. **`locateFile`**: with `importScripts` the `.wasm` is looked up next to the
    worker, not next to the core's JS; the worker redirects it to
    `../build/out/`.
13. **PCE does not name two keys properly**: `i` is called `"I"` and the right
    Shift has no name. `pce_st_key_from_name` resolves them. On the ST keyboard,
    Help is `End` and Undo is `PageDown` (fixed by PCE); there is no Page Up.
14. **Performance in real Chrome**: 71.1 fps, 0.999× real time, no audio
    underruns. In turbo, ~6× (≈425 fps).
15. **Pointer Lock works in headless Chrome** with DevTools events and delivers
    `movementX/Y`, so the mouse is tested end to end.
16. **Test trap**: a freshly created video buffer is all black, and "many dark
    pixels" mistakes it for the desktop (which is dotted, ~48 % dark). The
    desktop detection bounds that percentage.
17. `tests/browser/cdp.js` is a minimal client for the DevTools protocol
    (hand-written WebSocket, no dependencies) that launches Chrome, evaluates JS
    and sends input.
18. **Mounting a floppy: eject before writing the file.** On eject, PCE saves the
    previous floppy to the file if the guest modified it; if the new image had
    already been written at that path, it was overwritten with the old one and the
    mounted floppy was a mix. Fixed in the harness and in the worker (order:
    `disk.eject` → write → `disk.insert`); a test covers it.

## What was verified and what was not

Verified in Node (14 tests): EmuTOS boot to the desktop in mono (640×400) and in
color (320×200); determinism between instances; equivalence of stepping by cycles
or by frames; audio at emulated-time pace; the PSG produces the programmed tone
(279 Hz measured); mouse (motion and click); keyboard; mounting a `.st` created
in JS, with TOS reading its directory; guest write recovered with
`pce_st_disk_flush`; snapshot by memory dump; PCE messages.

In the browser (real Chrome, 9 tests): real-time start (71 fps, 1.0×), turbo,
pause/resume, color monitor, keyboard, mouse with Pointer Lock, end-to-end audio
(silence, tone, back to silence), floppy mounting from the interface.

Not verified: **Firefox and Safari**, mobile/touch, joystick (how PCE exposes it
to the terminal layer), ACSI hard disks, `.msa` and `.dim` formats, medium
resolution (640×200), audio drift in long sessions, memory growth in snapshots,
STE.

## Repository layout

See `README.md` ("Repository layout") for the tree. Summary of what each part
does and where its reference is:

| Part | Reference |
|---|---|
| `core/` (C glue and configuration) | `CORE_API.md` |
| `web/` (page, worker, audio, keyboard) | `WEB.md` |
| `scripts/` (`build-core.sh`, `serve.js`) | `README.md` (getting started) |
| `tests/` (core in Node, browser in Chrome) | `README.md` (tests), `WEB.md` |
| `roms/emutos/` | `roms/emutos/README.md` |
| Analysis of jsA8E's shell | `jsA8E_integration.md` |
| Goal, scope and risks | `../requirements.md` |

## First-session deliverables (`requirements.md` §11)

| # | Deliverable | Status |
|---|---|---|
| 1 | WASM/JS decision and reproducible build | **Done**: WASM, Emscripten 7.0.0 pinned, `scripts/build-core.sh`. |
| 2 | Minimal ST prototype with EmuTOS in a page (video, audio, keyboard, mouse) | **Done** and tested in real Chrome (`web/`). |
| 3 | Project notes and directory structure | **Done** (this file and `README.md`). |
| 4 | List of what was copied from jsA8E with its origin commit, and what was discarded | **Pending**: nothing has been copied from jsA8E yet. It will be done in step 2 and recorded in `NOTICE.md`. |
| 5 | GPL v2 and copyright notices for Hampa Hug and James Friend | **Done**: `COPYING` and `NOTICE.md`. |

## Decisions made (2026-11-15)

- **Official language: English.** Everything that goes into the repository is in
  English: documentation, UI text (menus, buttons, labels), on-screen and error
  messages, code comments, test names and commit messages. This applies to code
  copied from jsA8E as well (its UI and docs are already English; anything in
  another language must be translated when it is copied).
- **Independence from jsA8E**: the project is independent and will diverge.
  What is useful is brought in (copied) from `../A8E/jsA8E` and the origin commit
  (`30fb949`) is recorded; no later synchronization is maintained. It replaces the
  "copy or share" question in `jsA8E_integration.md` §7.
- **Prefix**: `PCE_ST` (e.g. `window.PCE_STApp`, `window.PCE_STAutomation`,
  database `pce_st_disk_library`). **No reference to jsA8E/A8E may remain** in
  the copied code (global names, `localStorage`/IndexedDB keys, UI text,
  comments, paths).
- **Loop**: the worker runs the loop with exact cycles (`st_step_frame()`), not
  PCE's real-time loop.
- **Mouse**: relative with pointer capture (Pointer Lock) by default; PCE's IKBD
  receives `set_mouse(dx, dy, buttons)`. A capture button in the toolbar, release
  with Esc or on focus loss, speed multiplier (`mouse_mul_*`/`mouse_div_*` of
  PCE's terminal). On touch: trackpad mode (drag = deltas, tap = left click, long
  press = right click). No "follow the host cursor" mode in the first version: it
  would require guessing the guest cursor's position (TOS/GEM-specific). The
  IKBD's absolute mode is only enabled by the guest software.

## Next step (phase 2, step 2)

Copy and prune the shell from `../A8E/jsA8E` (commit `30fb949`, prefix `PCE_ST`,
no reference to jsA8E/A8E) and write `PCE_STApp` (an adapter with the
`A8EApp.create()` API) on top of `web/`'s worker. See `jsA8E_integration.md` §2
and §4.

## Still to decide

Open questions from `requirements.md` §12 (resolved: WASM, mouse, loop, prefix,
default ROM, language):

- Official hardware references for the ST (hardware manuals, "Atari ST
  Internals") to settle before making compatibility fixes.
- Hardware scope: **by default, ST only**. PCE also offers `mega`
  (`PCE_STConfig` already accepts `model: "mega"`) but it has **not been
  tested**; the STE does not appear in PCE's configuration.
- Desktop (Tauri) and mobile: **deferred**; the mobile layout is inherited when
  the shell is copied.
- Product name (today: prefix `PCE_ST`, repository `pce_ST`).

## License

Code derived from PCE (Hampa Hug, GPL v2) and PCE.js (James Friend, GPL v2), plus
the EmuTOS ROM (GPL). See `COPYING` and `NOTICE.md`. When copying code from
jsA8E, record its authorship and origin commit in `NOTICE.md`.
