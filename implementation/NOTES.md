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
- Phase 2, step 1 (minimal skeleton in the browser): **done** (2026-11-15).
- Phase 2, **step 2** (jsA8E's shell with `PCE_STApp`): **done for the shell's
  frame and the emulation controls** (2026-11-15): the page has jsA8E's look
  (toolbar, themes, CRT screen, mobile tools), the machine runs behind
  `PCE_STApp`/`PCE_STAppProxy`, and keyboard, mouse (capture and touch
  trackpad), audio, floppy and ROM loading and snapshots (API) work, tested in
  real Chrome.
- Phase 2, step 2b: **on-screen Atari ST keyboard and joystick** (2026-11-15), also
  tested in real Chrome. **Deliberately left for later** (they need the library or
  are separate features): layout schemes with side panels, disk library and its UI
  (step 3), HostFS, snapshot UI, persistent ROM library, remote sync, the
  automation API/MCP (step 4), physical gamepad, assembler and debugger UI.
- Phase 2, step 3 (media and library): **done** (3a-3d: library core, panel and Work layout, ROM library, workspace, guest changes saved, FAT12 contents view, MSA; see `LIBRARY.md`).

## How to build and test the core

Requirements: `emsdk` in `~/emsdk` (or `EMSDK_DIR`), a clone of
<https://github.com/Leorivasc/pce> in `~/Documents/GIT/pce` (or `PCE_SRC`),
Node, Python 3, make.

```bash
scripts/build-core.sh                              # ~30 s -> build/out/
node tests/core/core.test.js                       # 19 tests, ~35 s
node tests/browser/browser.test.js                 # 39 tests in real Chrome, ~5 min
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

### Joystick (step 2b)

25. **PCE has no joystick input of its own**: it emulates one with the numeric
    keypad (`kbd->keypad_joy`, switched by a "magic" `KP_5` event). The glue sets
    that mode directly (`pce_st_set_keypad_joystick`) so it is deterministic and
    can be tested (`pce_st_joystick_state` reads the IKBD's state). While the mode
    is on the keypad no longer types digits, hence the on-screen joystick turns it
    on only while it is shown, and `PCE_STApp.joystick()` ignores presses when it
    is off.
26. The IKBD's joystick 1 is the standard port; port 0 shares the mouse port.
    The on-screen joystick uses port 1. A physical gamepad is not wired up yet.

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

## Browser

The page, the `PCE_STApp` API, the run loop, rendering, input and the UI are
documented in `WEB.md`. The code is in `web/`; `core/st_config.js` generates the
core's configuration text and is shared by Node and the worker; `scripts/serve.js`
is a static server without dependencies.

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

### Step 2 findings

19. **Painting must be decoupled from emulation.** With the CRT filter on and
    software WebGL (headless Chrome has no GPU), a CRT-filtered frame costs more
    than emulating it: turbo was no faster than real time (0.9×; 4.7× with the
    filter off). In turbo the picture is now refreshed at most every 100 ms (1.5×
    with the filter on, 6× off). A real GPU should not need this, but it was not
    possible to measure here.
20. **A test that cannot fail is worse than no test.** `writeMemory` only accepted
    a `Uint8Array`; the tests passed arrays, the call failed silently, and the
    "mute" test passed because the tone was never generated. The API now accepts
    arrays, and the mute test also proves the tone is heard when audio is back on.
21. **Test isolation in Chrome**: preferences persist in `localStorage` between
    pages of the same origin (a test that selected the color monitor changed every
    later test), so the test client clears it on close; stray Chrome helper
    processes survived a killed run, so Chrome now runs in its own process group
    and is killed as a group; calls pending when Chrome exits are rejected instead
    of hanging forever. Pages in tests open with `?crt=0`. Assertions on UI state
    that follows a browser event (for example the mouse button after Pointer Lock)
    wait for it instead of reading it at once: the lock is set a moment before the
    `pointerlockchange` event fires, and under load that gap showed up as a flaky
    test.
22. **No network at run time**: jsA8E's page loaded Font Awesome and two Google
    fonts from CDNs; they are vendored in `web/vendor/` (licenses in
    `NOTICE.md`), in line with the "no external dependencies" rule.
23. **Commands sent while the machine is being created are lost** unless queued:
    the worker holds every message until `PCE_STApp.create()` has finished.
24. The CRT shader includes a composite-video color-bleeding stage. **Decision
    (user, 2026-11-15): keep it**, since the STFM had a TV (composite) output; the
    shader is unchanged.

## Copied from jsA8E (origin commit `30fb949`)

Recorded for deliverable 4 of `requirements.md` §11. Everything was renamed to
`PCE_ST` (globals, storage keys, text); no reference to jsA8E/A8E remains in the
code. Attribution is kept in `NOTICE.md`.

| Taken | Where | How |
|---|---|---|
| Page structure and look | `web/index.html` | Toolbar (primary and secondary rows), brand/help tooltip, screen panel, input panel row, mobile action bar and tools sheet, ROM notice. Rewritten with the ST's controls; English text. |
| Joystick | `web/index.html` (CX40 markup), `web/style.css`, `web/js/app/joystick.js` | The CX40 markup and styles are copied; the stick logic (drag, dead zone, fire) is a port that reports a state object instead of key events. |
| On-screen keyboard | `web/js/app/keyboard.js`, `web/style.css` (end) | New: the Atari 8-bit keyboard does not carry over. Only the idea (buttons carrying key codes, sticky modifiers) is shared. |
| Styles | `web/style.css` | Copied unchanged, except: the two Google Fonts imports now point to local fonts, and a few rules were added at the end (status line, touch). Unused selectors of the removed panels remain for now. |
| LED sprite | `web/assets/leds.png` | Copied. |
| CRT shaders | `web/js/render/shaders/vert.glsl`, `crt.frag.glsl` | Copied unchanged. `decode.frag.glsl` is new (RGB source instead of a palette lookup). |
| Renderer | `web/js/render/gl.js` | Adapted from jsA8E's two-pass renderer: RGB texture source, variable size, no palette or VBXE planes. |
| UI logic | `web/js/app/ui.js` | Rewritten around the pieces that carry over: theme preference, screen sizing and fullscreen, run/pause request handling, secondary controls, mobile tools, toggle buttons. |
| Worker/proxy design | `web/emulator_worker.js`, `web/js/core/app_proxy.js` | Same shape (worker + proxy mirror + request/response with timeouts), new and much smaller code. |
| Audio worklet | `web/js/audio/worklet.js` | Own code (a sample queue), same role. |

**Left out for now** (not needed at this step, or tied to the 8-bit Atari): the
on-screen Atari 8-bit keyboard (replaced by the ST's), console keys, layout schemes and side
panels, the disk library and its UI, HostFS, the assembler, the printer, the
snapshot UI, the persistent ROM library, remote sync, the automation API and MCP
server, the physical gamepad support, the 6502 debugger and everything in `js/core` that emulates
the 8-bit machine (CPU, ANTIC, GTIA, POKEY, SIO, VBXE, ...). Library, ROM
persistence and snapshots arrive in steps 3 and 4.

## What was verified and what was not

Verified in Node (16 tests): EmuTOS boot to the desktop in mono (640×400) and in
color (320×200); determinism between instances; equivalence of stepping by cycles
or by frames; audio at emulated-time pace; the PSG produces the programmed tone
(279 Hz measured); mouse (motion and click); keyboard; mounting a `.st` created
in JS, with TOS reading its directory; guest write recovered with
`pce_st_disk_flush`; snapshot by memory dump; PCE messages.

In the browser (real Chrome, 38 tests): self-start in real time (71 fps, 1.0×), the
English UI, pause/resume, turbo, the real keyboard, end-to-end audio (silence,
tone, back to silence), muting, the WebGL2 CRT filter and its button, the
monitor and memory selectors (checked against TOS's `phystop`), floppy and ROM
file selectors (including rejecting a wrong-size ROM), theme persistence,
snapshots, Pointer Lock capture and mouse motion, the on-screen keyboard and
joystick, touch trackpad, the mobile tools and input bar and the ROM notice.

Not verified: **Firefox and Safari**, real touch devices (only emulated touch),
the CRT filter's speed on a real GPU, tap and long-press clicks (only dragging
is tested), joystick (how PCE exposes it
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
| Library plan (step 3) | `LIBRARY.md` |
| Goal, scope and risks | `../requirements.md` |

## First-session deliverables (`requirements.md` §11)

| # | Deliverable | Status |
|---|---|---|
| 1 | WASM/JS decision and reproducible build | **Done**: WASM, Emscripten 7.0.0 pinned, `scripts/build-core.sh`. |
| 2 | Minimal ST prototype with EmuTOS in a page (video, audio, keyboard, mouse) | **Done** and tested in real Chrome (`web/`). |
| 3 | Project notes and directory structure | **Done** (this file and `README.md`). |
| 4 | List of what was copied from jsA8E with its origin commit, and what was discarded | **Done for step 2**: see "Copied from jsA8E" above (updated as more is copied) and `NOTICE.md`. |
| 5 | GPL v2 and copyright notices for Hampa Hug and James Friend | **Done**: `COPYING` and `NOTICE.md`. |

## Decisions made (2026-11-15)

- **Official language: English.** Everything that goes into the repository is in
  English: documentation, UI text (menus, buttons, labels), on-screen and error
  messages, code comments, test names and commit messages. This applies to code
  copied from jsA8E as well (its UI and docs are already English; anything in
  another language must be translated when it is copied).
- **CRT filter** (2026-11-15): keep jsA8E's shader unchanged, including its
  composite-video color bleeding, because the STFM had a TV output.
- **Order of work** (2026-11-15): the on-screen keyboard first (Atari ST styled), with
  the joystick from jsA8E (CX40); then the library (step 3).
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

## Finding 27: swapping floppies (2026-11-15)

Replacing or exchanging disks kept showing the old disk's files in TOS. Cause: TOS detects a
change from the write-protect line, which PCE holds up for only 100 ms after an eject and then
restores to the old disk's value; eject+insert back to back (or even seconds apart) was
invisible to it. Fix: `pce_st_disk_hold_empty` in the glue, plus a 0.5 s emulated-time gap
between eject and insert in `PCE_STApp` and the automation API (details in `CORE_API.md`).
Regression tests: headless desktop screenshots compared pixel by pixel with a machine that only
ever had the second disk, and a check that A: and B: each show their own disk in any mount order.
Note: an early version of the fix skipped the eject on a first mount and inserted B:'s image
into A: (`disk.insert` goes to the drive of the last eject); the test for both drives covers it.

## Finding 28: saving a floppy during a transfer (2026-11-16)

Copying B: to A: failed with "Data on the disk in drive A: may be damaged" and the drive stayed
unusable. Cause: `pce_st_disk_flush` (called by the library as soon as the guest changes a
floppy) goes through `st_fdc_save`, which calls `wd179x_flush`; that clears the drive's track
buffer, throwing away the state of a command TOS is in the middle of. Fix: the glue returns 2
while the WD1772 is busy and `PCE_STApp`/the automation run a little emulated time and retry
(interface version 3). Regression test: a copy with both drives saved every 5 frames (it fails
without the busy check).

## Finding 29: drive LEDs (2026-11-16)

The library panel already blinked a LED on `app.onDiskActivity`, but the app never produced
those events. `pce_st_disk_activity` (interface version 4) samples the WD1772 every 16 cycles
(busy + command type + selected drive, only for a drive holding a disk); `PCE_STApp` emits the
events from the run loop and from `stepFrames`. Browser test: the guest-write test checks for
`0read` and `0write` events.

**Correction (2026-11-16): the panel's LEDs never lit.** `ui.js` handed the library panel an `app`
object without `onDiskActivity`, so the panel never received the events (the browser test only
checked them on the proxy). It is wired now. A second fault hid behind it: every event called the
panel's full `render()` (events arrive on every tick while a game loads), which rebuilt the LED and
restarted its blink animation, so it would have stayed on the first (dim) frame. Now an event updates
only that LED in place and the blink repeats until 900 ms after the last event. Browser test: "the drive
LED stays lit while the floppy is being read" (fails without the wiring and without the in-place update).

## Finding 30: chained ROM switches are not serialized (2026-11-16, open, low priority)

Found while investigating one intermittent failure of the browser test "a loaded ROM is kept in
the ROM library and chosen again after a reload" (timed out waiting for "ROM removed"; it passed
when rerun alone and in 5 further full runs of the suite, so 1 failure in 7 runs).

- `switchRom` (`web/js/app/ui.js`) sets the ROM label **first** and then runs `loadRom`,
  `powerCycle` and `start`; `chooseRom` refreshes the selector only when all of that is done.
  Each switch is an independent async call, so two switches in a row overlap. The label changed in
  about 25 ms, so it does not tell that the machine has restarted. The test waits for the label
  and moves on, so it overlaps switches too.
- Overlapping switches log `The machine is not ready (is a ROM loaded?)` (from `PCE_STApp`). With
  the waits for "machine ready" between the steps the error did not appear (one run each).
- Stress run in the browser console (30 switches 5 ms apart, last one asked for `kept_tos`): the
  machine ended running with a ROM loaded, but the label said `EmuTOS` and the selector said
  `kept_tos`. Which ROM was really running was not checked.
- **Not shown:** that this is what made the test fail. A normal run of the same steps finishes in
  ~185 ms, far below the test's 15 s limit, so the failing run needed something to stall.
- **Priority:** low. Nobody switches ROMs several times within milliseconds, EmuTOS is the default
  and few ROMs are kept. Nothing was changed in the code or in the test.
- **If it is fixed:** queue the ROM switches so they run one at a time in the order asked, and
  write the regression test first (several switches without waiting; label, selector and
  `romLoaded` must match the last one asked; it must fail today).

## Finding 31: Pasti (.stx) images (2026-11-16)

- PCE already **loads** `.stx` (its PSI code); the core needed no change. The format is picked from
  the extension, so the page mounts them as `/disks/fdN.stx`. A synthetic image (built from a `.st`
  by `tests/core/stximage.js`) shows exactly the same A: window as the `.st`.
- PCE **cannot save** `.stx`: `psi_save_stx` always fails. After a guest write, `pce_st_disk_flush`
  returned 0 and the file was left **empty (0 bytes)**, which the library would have stored as a new
  revision. So `.stx` is read-only: `PCE_STApp` and the automation keep the original bytes, never
  flush or read the file back, and report `readOnly: true` and `modified: false`. Writes are not
  blocked (a write-protected disk would also stop TOS noticing a disk change, finding 27): they live
  in the machine's memory and are lost on eject. A test shows the empty file when the guard is
  removed.
- The library stores `.stx` as it is (format `stx`, no conversion), without revisions from the
  machine; verification and the FAT12 file view are not available for it. Packages and remote sync
  accept the type.
- Tried with 12 real Pasti images (a games compilation, not in the repository; read from outside it):
  all insert without error. Title or menu screens were seen for Afterburner, R-Type, Space Harrier,
  Double Dragon and Black Lamp / Out Run; Gauntlet II sat on "LOADING"; **Super Hang-On stayed
  black** after ~56 s. The other five were not looked at. PCE ignores the raw track image and most of
  Pasti's timing, so protected disks can fail: investigate per disk.

## Next step (phase 2, after step 3)

Done since step 3: snapshot UI, physical gamepad, headless automation + MCP server
(`AUTOMATION.md`), WebDAV remote sync (ported, tested against a mock server) and floppies
built from files/folders. Open: validate remote sync against a real Nextcloud and
document the user's CORS setup; breakpoints/stepping in the automation (needs PCE's debugger
exported from the glue); driving the open browser page through MCP; `.dim`/ACSI images
(need real samples). Unverified: real-GPU CRT speed, real touch devices, Firefox/Safari.

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
