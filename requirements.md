# pce_ST — Requirements and feasibility assessment

Starting document for a new project: an **Atari ST emulator for the browser**
that takes the PCE / PCE.js code as its emulation core and **jsA8E** (the 8-bit
Atari emulator of the A8E project) as its shell (look, features, library, sync,
automation).

This directory was created inside the A8E repository only to write down the
starting point. **It is going to be moved out of A8E and continued in a
different development session.** That is why the document is self-contained: it
does not assume that whoever reads it has seen the original conversation or has
A8E open. When something lives in A8E, its path is given (`A8E/jsA8E/...`) so it
can be copied or consulted.

Date written: 2026-11-15.

> **Status of this document (2026-11-15).** This is the starting document; part
> of it has already been superseded by what has been done since. What is current
> is in `implementation/NOTES.md` (status, decisions, findings) and
> `implementation/jsA8E_integration.md` (analysis of the shell and the phase 2
> plan).
>
> - §4: option A (WASM) **was confirmed**; with Emscripten 7.0.0 (the 1.38.48 is
>   not needed) and without SDL or PCE's loop (`core/st_glue.c`).
> - §5 and §6: **superseded** by `jsA8E_integration.md` (the seam is
>   `A8EApp.create()`; the machine contract is the `pce_st_*` API, see
>   `implementation/CORE_API.md`).
> - §7: phases 0 and 1 are **done** and phase 2 has started (step 1 done).
> - §9: risks 2 (snapshots), 3 (determinism), 5 (build) and 6 (SDL layer) are
>   **resolved**; see the findings.
> - §11: deliverables 1, 2, 3 and 5 done; 4 depends on copying the shell.
> - §12: WASM, mouse, default ROM, prefix and language resolved; the rest are in
>   "Still to decide" in `NOTES.md`.

---

## 1. Goal

Create an **Atari ST** emulator (first machine) that looks and works like
jsA8E:

- Same look of the site: toolbar, dockable or floating panels, themes, mobile
  layout.
- Same everyday emulation features: start, pause, reset, turbo, audio, full
  screen, keyboard and mouse, joystick/gamepad, mounting disks, snapshots.
- Same media **library**: folders, revisions, preferred revision, metadata,
  workspaces, trash, package import and export.
- Same **sync** (OnlineDrive: remote library and workspaces).
- Same **automation**: grouped API (`window.A8EAutomation` in jsA8E), headless
  harness for Node and an MCP server.

It is a **new, separate product**, not an integration inside jsA8E. jsA8E is not
modified to support the ST.

### Out of scope for the first phase

- **Mac Plus.** PCE also emulates it; it is explicitly left for later (see §10).
  User decision: "let's start with ATARI ST and leave Mac for later".
- IBM PC/XT and the rest of PCE's architectures (CP/M-80, Spectrum, VIC-20,
  RC759, simarm, sims32, sim405).
- Built-in assembler. The user indicated that utilities such as the assembler
  editor may take more effort and are not needed at the start. jsA8E's is a 6502
  one; for the ST a 68000 one would be needed.
- A debugger with full parity. jsA8E's is a 6502 one (see §6 and §9).

---

## 2. Engineering rules inherited from A8E

These rules are in `A8E/AGENTS.md` and the user expects the new project to keep
them (adapting what is specific to the 8-bit Atari):

- No external dependencies in the project's code. Prefer the standard library and
  existing code.
- Current coding standards. Simple, readable, maintainable code.
- Small, focused changes, without unnecessary abstractions.
- Keep a notes file (`implementation/NOTES.md` in A8E) and update it after every
  improvement; read it before planning.
- Software compatibility fixes: always **generic**, benefiting the emulator.
  Never patches for a particular application or game.
- In A8E, the hardware reference is the AHRM (Atari Hardware Reference Manual)
  for the 800 XL. **It does not apply to the ST.** The new project needs to set
  its own ST hardware references (see §12, open question).

Rule added in this project (2026-11-15): **the official language is English.**
Documentation, UI text (menus, buttons, labels), on-screen and error messages,
code comments, test names and commit messages are all in English, even though
conversations about the project may happen in another language.

Commit conventions used in A8E: commits end with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push or merge
unless the user asks.

---

## 3. The starting source code: PCE.js

The user's fork: <https://github.com/Leorivasc/pce>

It was cloned (shallow) only to study it, outside the A8E tree. Last revision
seen: `b2e4b44 Expose SDL on the Module again`.

### 3.1 What it is

**PCE.js** is the browser port, by **James Friend**
(<https://jamesfriend.com.au/>), of the **PCE** emulator by **Hampa Hug**
(<http://www.hampa.ch/pce/>). According to its README it is based on PCE
`20250420-cc0c583c` (April 2025). Written in **C**, it is compiled to
JavaScript/WASM with **Emscripten**. It functionally emulates Mac Plus, IBM PC/XT
and Atari ST in recent Chrome and Firefox.

The README describes these changes with respect to PCE for the browser:

- Main loop driven by `requestAnimationFrame` (`*_run_emscripten()` in
  `src/arch/*/cmd*.c`, using `pce_em_*()` from `src/lib/sysdep.c`). It emulates
  the real time elapsed since the previous frame instead of sleeping. With the
  page hidden it runs from a timer, because the browser pauses animation frames.
- `pce_usleep()` does not sleep and the real-time synchronization functions
  (`*_realtime_sync()`, `pc_clock_delay()`) return early.
- Browser defaults in `src/arch/*/main.c` (configuration file `pce-config.cfg`,
  debug log, VGA for the IBM PC).
- The Mac Plus mouse uses the host's absolute mouse position.
- The Atari ST uses the `sdl` sound driver for the PSG by default.
- Codes for some browser keys in `src/drivers/video/sdl.c`.

### 3.2 License

**GNU GPL version 2** (the source files state "GNU General Public License
version 2 as published by the Free Software Foundation"; `COPYING` is the GPL
v2). A8E is also GPL v2, so there is no conflict. Obligations: keep the copyright
notices of Hampa Hug (e.g. "Copyright (C) 2011-2019 Hampa Hug") and of James
Friend, and distribute the resulting source code under GPL v2. PCE.js's
`package.json` also declares `"type": "GPL"`.

### 3.3 Repository structure

```text
src/
  arch/            atarist/ macplus/ ibmpc/ dos/ cpm80/ rc759/ sim405/ simarm/ sims32/ spectrum/ vic20/
  chipset/         e68901.c (MFP), e6850.c (ACIA), e6522.c (VIA), e8530.c (SCC),
                   wd179x.c (FDC), e6845.c, e6560.c, 80186/, 82xx/, clock/, ppc405/
  cpu/             e68000/ e6502/ e8080/ e8086/ arm/ ppc405/ sparc32/
  devices/         fdc, hdc, ata, memory, nvram, parport, serport, speaker, video/, clock/
  drivers/         block/ char/ pfi/ pri/ psi/ pti/ sound/ video/ options.c
  lib/ libini/ include/ utils/
libjs/             library_sdl.js  (minimal SDL for Emscripten)
commonjs/          npm packages (pcejs-atarist, pcejs-macplus, pcejs-ibmpc, pcejs-util)
example/           examples per architecture + webserver.js + run_example.sh
dist/              HTML and CSS of the Mac Plus demos (dist/js is empty until built)
test/              unit/glue.test.js, browser/ (Playwright: boot.spec.js, timing.spec.js)
scripts/           10-configure, 20-make, 21-remake, 30-afterbuild, pcejs_build_env, ...
pcejs_build        main bash build script
```

### 3.4 Size of the code relevant to the ST (lines of C)

| Part | File(s) | Lines |
|---|---|---|
| 68000 CPU (includes 68010/68020) | `src/cpu/e68000/*` | ~11.8k |
| Complete Atari ST machine | `src/arch/atarist/*` | ~10.2k |
| Video (Shifter) | `atarist/video.c` | 719 |
| PSG YM2149 | `atarist/psg.c` | 787 |
| IKBD keyboard/mouse (HD6301) | `atarist/ikbd.c` | 1128 |
| MFP 68901 | `chipset/e68901.c` | 937 |
| WD1772/179x floppy controller | `chipset/wd179x.c` | 2027 |
| ACIA 6850 (keyboard/MIDI) | `chipset/e6850.c` | — |
| RTC RP5C15 | `atarist/rp5c15.c` | — |
| DMA and ACSI (hard disk) | `atarist/dma.c`, `acsi.c` | — |
| MIDI | `atarist/smf.c` | — |
| Video drivers | `drivers/video/*` (sdl, sdl2, x11, terminal, null) | ~5.1k |
| Sound drivers | `drivers/sound/*` (sdl, oss, wav, null, filter) | ~1.8k |
| Disk image formats | `drivers/block/`, `drivers/psi/` (PSI), `pri`, `pfi`, `pti` | — |

For reference, the Mac Plus is ~14.4k lines (VIA 6522 972, SCC 8530 1318, IWM
1363, SCSI, ADB, video 272). **It is not a goal of the first phase.**

The ST's video advances by clock (`st_video_clock (st_video_t *vid, unsigned cnt)`
in `video.c`), which gives a reasonable base for raster effects, but **its
accuracy was not measured**; it has to be verified.

### 3.5 ST configuration in PCE (`src/arch/atarist/pce-atarist.cfg.in`)

Relevant parameters that the new shell will have to expose or fix:

- `system.model`: `"st"` or `"mega"` (Atari Mega).
- `system.fastboot`: disables the boot memory test.
- `system.mono`: monochrome (1) or color (0) monitor.
- `system.rtc`: Mega-compatible RTC even on an ST.
- `system.frame_skip`: update the screen every n-th frame.
- `system.viking` / `viking_boot`: Viking monochrome card.
- `system.parport`, `serport`, `midi_raw`, `midi_smf`: character devices (in the
  browser they will have to go to a backend of our own, not to
  `stdio:`/`pty:`/`tios:`).
- `cpu.model`: `"68000"`, `"68010"`, `"68020"`; `cpu.speed`: multiplier
  (1 = 8 MHz, 0 = dynamic).
- `ram.address`, `ram.size` (the example uses 1024K).
- `rom.file` (example: `tos-1.04-us.rom`), `rom.address = 0xfc0000`,
  `rom.size = 192K`.
- `disk { ... }` blocks: two floppies and up to four ACSI hard disks.
- Search paths: `rom`, `PCE_DIR_DATA/atarist`, `.`.

---

## 4. Key technical decision: WASM or a rewrite in JS

The project's central decision. It was discussed with the user and **starting
with WASM was recommended**, but **it is not a closed decision**: the user must
confirm it.

### Option A — Compile the C core to WASM (recommended)

The new shell (from jsA8E) runs in JS and PCE's WASM works underneath.

- Advantages: the fastest route; the core already works and is proven; low risk.
- Drawback: **Emscripten** is needed as a build tool.
- How it fits the "no external dependencies" rule: A8E already has a native core
  in C and the rule is understood to apply to the project's code, not to a build
  toolchain. Even so, **it is the user's decision**.
- **Important warning:** PCE.js's README requires **Emscripten SDK 1.38.48**
  (very old), with these documented stumbling blocks:
  - It runs its scripts with `python`, so on systems with only `python3` a
    `python -> python3` symlink is needed in the `PATH`.
  - `./configure` runs test programs with node; on node 18 or newer they fail
    ("Failed to parse URL") unless `fetch` is disabled: set
    `NODE_JS = ['/usr/bin/node', '--no-experimental-fetch']` in the SDK's
    `.emscripten`, or, on newer node, preload a script with
    `delete globalThis.fetch;`
    (`NODE_JS = ['/usr/bin/node', '--require', '/path/nofetch.js']`).
  - It has to be checked whether the code builds with a modern Emscripten.
    **That has to be tried in the first prototype**; it was not verified.
- The integration is deeper than "linking a module": PCE depends on SDL
  (`libjs/library_sdl.js`, `drivers/video/sdl.c`, `drivers/sound/sound-sdl.c`),
  has its own main loop (`pce_em_run`) and its own build script (`pcejs_build`:
  tasks `env`, `init`, `configure`, `make`, `remake`, `clean`, `afterbuild`,
  `build`, `rebuild`, `example`). The new shell will have to **replace** the SDL
  layer with an interface of its own (video, audio, input).

### Option B — Rewrite the core in pure JavaScript

- Advantages: total consistency with jsA8E (debugger, snapshots, cycle timing,
  everything in the same language).
- Drawbacks: ~25k lines of C to translate (CPU ~11.8k plus ~10k for the ST, plus
  tests) and much more risk of introducing errors.
- It is only justified if debugging or timing at A8E's level is wanted.

### Recommendation

Start with **A**, with a **clean boundary** between core and shell (see §7). If a
JS core of the ST's own is wanted later, the boundary would already be defined.

---

## 5. What is inherited from jsA8E and where it is

Paths relative to the A8E repository (`A8E/jsA8E/`). The jsA8E tree has ~36.5k
lines of JS in `js/core` and `js/app` (the biggest files: `ui.js` 3602,
`memory.js` 2602, `app_proxy.js` 2326, `automation_api.js` 2216,
`disk_library.js` 2001, `atari.js` 1685).

### 5.1 Reused almost unchanged (shell)

| Area | jsA8E files |
|---|---|
| Interface and panels | `index.html`, `style.css`, `js/app/ui.js`, `js/app/a8e.js` (facade), `js/app/version.js` |
| Disk library | `js/core/disk_library.js`, `js/app/disk_library_ui.js` |
| Package and archive formats | `js/core/library_package.js`, `js/core/library_archive.js` |
| Remote sync | `js/app/remote_library.js`, `js/app/remote_sync_ui.js`, `js/app/remote_workspace.js` (see `implementation/OnlineDrive.md` in A8E) |
| HostFS (working files) | `js/core/hostfs.js`, `js/app/hostfs_ui.js` |
| Local ROMs (IndexedDB) | `js/core/rom_library.js` |
| Snapshots (container and interface) | `js/core/snapshot_codec.js`, `js/app/snapshot_ui.js` (the state contents change) |
| Emulation thread | `emulator_worker.js`, `js/core/app_proxy.js` (worker/proxy bridge and no-worker fallback) |
| Video output | `js/render/gl.js` (WebGL), `js/render/software.js` (Canvas), `js/render/palette.js`, `js/render/shaders/` |
| Audio output | `js/audio/runtime.js`, `js/audio/worklet.js` |
| Automation | `js/app/automation_api.js`, `js/app/automation/*.js`, `headless.js`, `mcp_server.js` |
| Gamepad | `js/app/gamepad.js` |
| Desktop | `src-tauri/` (Tauri) |
| Tests | `tests/` (138 files; golden-trace pattern and bus-level tests) |

Useful design documentation in `A8E/implementation/` (read it before copying):
`jsA8E/UI.md`, `jsA8E/WORKER.md`, `jsA8E/CORE.md`, `jsA8E/AUTOMATION.md`,
`jsA8E/RENDER.md`, `jsA8E/AUDIO.md`, `jsA8E/INPUT_HOST.md`, `OnlineDrive.md`,
`full_library.md`, `library_Import_export.md`, `layoutSchemes.md`, `MCP.md`,
`tauri.md`, `DIAGRAM.mermaid` (architecture diagram).

### 5.2 Specific to the 8-bit Atari (discarded or replaced)

`js/core/atari.js`, `cpu.js`, `cpu_tables.js` (6502), `antic.js`, `gtia.js`,
`pokey.js`, `pokey_sio.js`, `memory.js`, `io.js`, `hw.js`, `vbxe.js`, `state.js`,
`atari_snapshot.js`, `atari_support.js`, `hdevice.js`, `playfield/`,
`debugger.js` (6502), `assembler_core.js` and `assembler/` (6502),
`atr_inspector.js`, `disk_image.js` (ATR), `js/app/assembler_ui.js`,
`console_keys_ui.js`, `disk_activity_ui.js`, `printer_*`, `sio_printer.js`,
`keys.js`, `input.js` (8-bit Atari keyboard mapping), ROMs
`ATARIXL.ROM`/`ATARIBAS.ROM`, and the AHRM / PAL-NTSC references.

### 5.3 What has to be built from scratch

- **Core:** PCE's WASM (option A) or a JS core (option B).
- **Media:** ST disk formats in the library and in mounting (see §8).
- **Input:** ST keyboard and the **mouse as the main input**. On the ST the mouse
  is central; jsA8E barely uses it. PCE models the IKBD (HD6301), which
  translates keyboard/mouse/joystick: the shell must feed it with correct key
  events and relative/absolute motion events (the Mac Plus in PCE.js uses the
  host's absolute position; for the ST this has to be decided, see §12).
- **Video:** variable resolution. The ST has low (320×200, 16 colors), medium
  (640×200, 4 colors) and high (640×400, monochrome); in addition the mono/color
  mode depends on the connected monitor (`system.mono`). jsA8E's renderer assumes
  an 8-bit Atari geometry and will have to be parameterized.
- **Audio:** the YM2149 PSG goes out through PCE's `sdl` driver; it has to be
  replaced by an output to jsA8E's audio worklet.
- **The ST's own preferences:** model (st/mega), memory, monitor type, RTC, CPU
  speed.
- **Debugger:** disassembler and single-step execution for the 68000 (PCE already
  has `disasm.c` and a command-line debugger in `cmd.c`; it has to be decided
  whether to expose it through the shell).

---

## 6. Proposed design: the "machine" contract

Although the project is a separate product, the shell should talk to the core
through a small, explicit contract, so the core can be swapped (WASM today, JS
tomorrow) and, later, the Mac Plus can be added without rewriting the interface.
Minimal proposed operations:

1. Create/destroy the machine with a configuration (model, RAM, monitor, ROM).
2. Run a frame or a span of time/cycles.
3. Deliver video: pixel buffer, width, height and palette or format.
4. Deliver audio: blocks of samples with their rate.
5. Receive input: keys (with the ST's code), mouse motion and buttons, joystick.
6. Mount/eject media: floppies A:/B:, ACSI hard disks.
7. Save and restore state (snapshot).
8. Query debugging state: registers, memory, disassembly.
9. Describe its own panels/settings to the interface.

jsA8E's automation API by domains (`system`, `media`, `input`, `debug`, `dev`,
`artifacts`, `events`) is a good model; see `A8E/jsA8E/AUTOMATION.md`.

---

## 7. Phase plan

The plan agreed with the user, with the ST as the first machine:

0. **Code audit and build.** Confirm the license (done: GPL v2), the structure
   (done), and check that PCE builds to WASM with a usable Emscripten version and
   boots the ST.
1. **Minimal prototype.** Build PCE (`atarist`) to WASM, with a minimal page that
   shows video, plays audio and receives keyboard/mouse, booting with EmuTOS. It
   validates the technical risk all at once: build, video, audio, input, main
   loop.
2. **Shell.** Copy jsA8E's shell (§5.1), remove what is specific (§5.2) and plug
   the prototype in behind the contract of §6. jsA8E's look with the ST inside.
3. **Media, library and sync** for the ST's formats (§8).
4. **Snapshots, automation/MCP, headless and tests.** Includes a deterministic
   mode (see §9, risk 3).
5. **68000 debugger** and, if wanted, a 68000 assembler.
6. **Mac Plus** as the second machine (§10).

It is possible to stop after phase 2 and there would already be a usable
emulator.

---

## 8. Atari ST media

The library has to learn new formats. What PCE supports (verify which ones are
exposed in the shell):

- Floppies: `.st` (raw image), `.msa` (Magic Shadow Archiver), `.dim`; PCE also
  has the format drivers `psi`, `pri`, `pfi`, `pti` (`src/drivers/`) for flux and
  track images.
- Hard disk: ACSI images (up to four, `disk {}` blocks in the configuration).
- System ROM: TOS or EmuTOS (see §9, risk 1).

To be decided: how the library is modeled (the equivalent of ATR in jsA8E is a
floppy image), its metadata and content inspection (in jsA8E,
`atr_inspector.js`; the ST would use FAT12 on floppies).

---

## 9. Risks and points of attention

1. **ROM.** The ST boots with **TOS** (owned by Atari/successors, with the same
   legal problem already handled with the 8-bit Atari's ROMs) or with **EmuTOS**
   (free, GPL). Recommendation: boot with EmuTOS and allow the user's local ROMs
   stored in IndexedDB (`rom_library.js`), without uploading them or including
   them in the repository. A8E already added a ROM notice to its list of legal
   to-dos (`implementation/NOTES.md`, "Legal / License TODO" section).
2. **Snapshots.** PCE has its own internal state and it was not verified that it
   can be fully serialized. It has to be checked which devices expose their
   state, and if not, add it to the core.
3. **Timing and determinism.** PCE.js's port synchronizes with the browser's real
   time, not by cycles like A8E. That is fine for playing, but not for
   deterministic tests (golden traces). A mode that advances by exact cycles or
   frames has to be added for headless/MCP.
4. **ST accuracy.** Shifter and MFP effects (overscan, timers, per-line palette
   changes) demand cycle accuracy. PCE's video accuracy is not measured.
5. **Build toolchain.** Emscripten 1.38.48 and its stumbling blocks (§4). Try
   with a modern version.
6. **SDL layer.** The core asks for SDL for video, audio and input; it has to be
   replaced by the interface of §6 without breaking the main loop.
7. **Character devices.** `parport`, `serport` and MIDI point to
   `stdio:`/`pty:`/`tios:`; in the browser they need a backend (download,
   console, Web MIDI, or simply null).
8. **Scope.** The project is done in phases and one machine at a time; the Mac
   Plus is left for later.
9. **Tests.** PCE.js has only `test/unit/glue.test.js` and Playwright
   (`boot.spec.js`, `timing.spec.js`). A test net in the style of jsA8E's will
   have to be built.

---

## 10. Mac Plus (for later)

Outside the first phase by the user's decision. Notes for when it comes:

- PCE emulates the Mac Plus (~14.4k lines): 68000, VIA 6522, SCC 8530, IWM
  (floppy), SCSI, ADB, 1-bit 512×342 video.
- It requires the **Apple ROM** (same legal problem) and system software.
- PCE.js's Mac Plus uses the host's absolute mouse.
- The machine contract (§6) should allow adding it without redoing the
  interface. Planned media: `.dsk`/`.img` of 400K/800K and SCSI disks.
- A color Mac or one with a 68030 is further away still.

---

## 11. Deliverables expected from the new project's first session

1. A confirmed decision between WASM (A) and a rewrite (B); if A, the Emscripten
   version pinned and a reproducible build process documented.
2. A minimal ST prototype with EmuTOS in a page (video, audio, keyboard, mouse),
   with a build script and a note on how to run it.
3. A project notes file (equivalent to `implementation/NOTES.md`) and the
   directory structure.
4. A list of what was copied from jsA8E, with the origin version/commit, and what
   was discarded.
5. GPL v2 license and copyright notices for Hampa Hug and James Friend in the
   repository.

---

## 12. Open questions for the user

- **WASM or JS** (§4): is option A confirmed? *Resolved: yes, WASM.*
- **ST hardware references:** the AHRM only covers the 800 XL. Which ST
  documentation will be used as the official reference (e.g. ST/STE hardware
  manuals, "Atari ST Internals")? It should be settled before making
  compatibility fixes.
- **Hardware scope:** ST only, or also STE/Mega (PCE offers `st` and `mega`; the
  STE does not appear in the configuration seen).
- **Mouse:** relative (faithful to the hardware) or absolute with adjustment, as
  in PCE.js's Mac Plus? *Resolved: relative with Pointer Lock.*
- **Product name** and the new repository's name (here only `pce_ST` is used).
  *Prefix `PCE_ST` resolved.*
- **Desktop (Tauri) and mobile:** kept from the start or later?
- **Default ROM:** *Resolved (2026-11-15):* EmuTOS 1.4, 192 KB, is included in
  `roms/emutos/` (GPL). Atari's TOS ROMs are not included.
- **Project language:** *Resolved (2026-11-15):* English.

---

## 13. How to rebuild the context

(Historical. Since 2026-11-19 PCE's source is part of this repository, in
`third_party/pce/`, so there is nothing to clone; see `implementation/NOTES.md`,
"PCE inside the repository".)

- Clone the PCE.js fork: `git clone https://github.com/Leorivasc/pce` (last
  commit seen: `b2e4b44`). Read `README.md` (build instructions), `pcejs_build`,
  `src/arch/atarist/` and `src/arch/atarist/pce-atarist.cfg.in`.
- Read in A8E: `AGENTS.md`, `implementation/jsA8E/*.md`,
  `implementation/DIAGRAM.mermaid`, `implementation/OnlineDrive.md`,
  `implementation/MCP.md`.
- A8E advice that applies here: when a component is migrated to a new contract,
  **record a golden trace of the previous behavior and compare it byte for
  byte** (that is how the disk was migrated to the SIO contract in A8E without
  changing behavior). Useful when replacing PCE's SDL layer.
