# PCE_ST

An Atari ST emulator for the browser. The core is PCE (Hampa Hug, GPL v2)
compiled to WebAssembly; the shell (interface, library, sync, automation) is
being built from jsA8E's. Today there is a minimal working page (`web/`) and a
tested core; the full shell is phase 2, step 2 (see `implementation/NOTES.md`).

**Project language: English.** Documentation, UI text (menus, buttons, labels),
on-screen and error messages, code comments and test names are all in English.
(Conversations about the project may happen in any language.)

## Contents

- [Getting started from scratch](#getting-started-from-scratch)
- [Using the page](#using-the-page)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [License](#license)

## Getting started from scratch

Tested on Ubuntu 24.04 with Node 18.19, Python 3.12, make 4.3, git 2.43 and
Chrome 157. Everything that gets installed lives in your home directory; nothing
system-wide is touched.

### 1. System tools

```bash
node --version       # 18 or newer
python3 --version    # 3.x (the script creates the "python" alias by itself)
make --version
git --version
google-chrome --version || chromium --version   # only for the page and the browser tests
```

On Ubuntu/Debian: `sudo apt install nodejs git make python3 chromium`
(or install Chrome). There is no `npm install` step: the project has no
dependencies.

### 2. Emscripten (the WebAssembly compiler)

```bash
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk
./emsdk install 7.0.0
./emsdk activate 7.0.0
```

Tested version: **7.0.0**. The 1.38.48 that PCE.js's README asks for is not
needed. You do not have to run `emsdk_env.sh` by hand: `scripts/build-core.sh`
loads it itself. If emsdk is installed elsewhere: `EMSDK_DIR=/path/to/emsdk`.

### 3. PCE source code

```bash
git clone https://github.com/Leorivasc/pce ~/Documents/GIT/pce
git -C ~/Documents/GIT/pce checkout b2e4b44
```

Tested commit: `b2e4b44`. If you keep it somewhere else: `PCE_SRC=/path/to/pce`.
The script does **not modify** that clone: it builds a clean copy under `build/`.

### 4. Build the core

```bash
cd ~/Documents/GIT/pce_ST
scripts/build-core.sh
```

It takes about 30 s. When it finishes it leaves in `build/out/`:

- `pce_st_core.js` (module) and `pce_st_core.wasm` (~360 KB). They always go
  together.

The ROM (EmuTOS 1.4, GPL) is already in `roms/emutos/`; there is nothing to
download.

### 5. Start the page

```bash
node scripts/serve.js            # port 8080
node scripts/serve.js 9000       # another port
```

Open <http://127.0.0.1:8080/> in Chrome or Chromium and press **Start**.
Opening `web/index.html` through `file://` does not work: the browser will not
load `.wasm` or workers from disk, so the server is required.

## Using the page

The page starts the machine by itself (EmuTOS boots in ~18 s of emulated time;
with **turbo** it takes ~3 s). It has the look of jsA8E, with the **Atari ST**
theme by default.

| Control (toolbar) | What it does |
|---|---|
| Play / Pause | Starts or pauses emulation. |
| Reset (circular arrow) | Restarts the machine (power cycle: RAM is cleared; the floppy stays in its drive). |
| Speaker | Audio on/off. |
| ROM (`EmuTOS` + LED) | Loads another 192K TOS or EmuTOS ROM image and restarts. |
| Floppy (disk icon) | Opens a `.st` floppy image in drive A:. |
| Download | Saves floppy A: (with the changes the program made) as a `.st` file. |
| TV | CRT filter on/off (remembered). |
| Expand / window | Fullscreen for the display / for the whole workspace. |
| Chip with arrows | Turbo: run as fast as possible (audio is muted). |
| Mouse | Captures the mouse (same as clicking the screen). |
| Gamepad | Shows the on-screen joystick (port 1). |
| Keyboard | Shows the on-screen Atari ST keyboard. |
| Down arrow (right end) | Shows **Monitor** (mono 640×400 or color 320×200), **Memory** (512K to 4 MB) and **Theme**. Changing monitor or memory restarts the machine. |

- **Mouse**: click the screen to capture it (Pointer Lock); `Esc` releases it.
  Left, right and middle buttons. **Touch**: drag to move the cursor, tap to
  click, long press for right click.
- **On-screen keyboard**: an Atari ST keyboard (two-tone keycaps, function row, cursor
  cluster and numeric keypad). Tap a key to press it; several keys can be held on a
  touch screen. **Shift, Control and Alternate** stay down until the next key is
  released; double tap to lock one (red), tap again to unlock. Keys pressed on the
  physical keyboard light up on it. The `(` and `)` keypad keys are drawn but
  disabled: PCE has no key code for them.
- **On-screen joystick** (the CX40 from jsA8E, port 1): drag the stick, press the red
  button to fire. While it is shown, the numeric keypad keys `8 2 4 6` (and
  `7 9 1 3` for diagonals) move the joystick and `0` fires, because PCE emulates
  the joystick with the keypad.
- **Keyboard**: active while the screen has focus or the mouse is captured.
  ST-specific keys: **Help = End**, **Undo = Page Down** (there is no Page Up).
  While the mouse is captured, `Esc` releases it and does not reach the
  program; with the mouse released and the screen focused it does.
- **Floppies**: whatever the program writes to A: stays in memory; use the
  download button to get the updated image. Mounting another image replaces the
  previous one **without downloading** anything that was modified: save first.
- **Status line** (bottom left of the screen): fps, speed relative to real time
  and video size. In monochrome at 1× it should read ~71 fps and ~1.00x.
- **URL option**: `?crt=0` / `?crt=1` forces the CRT filter for that session.
- **On a phone** the toolbar's extra controls move to a tools sheet ("More"), and the
  action bar switches between the keyboard and the joystick.

## Tests

```bash
node tests/core/core.test.js        # core in Node: 15 tests, ~35 s
for t in library_archive library_package disk_library st_image snapshot_codec gamepad; do node tests/library/$t.test.js; done   # library, seconds
node tests/browser/browser.test.js  # page in real Chrome: 36 tests, ~4 min
```

- Both need `scripts/build-core.sh` to have been run first.
- The browser tests start their own server on a free port and launch headless
  Chrome (`CHROME=/path/to/browser` if it is not on the `PATH`).
- A single test: `--only=text` (part of its name), for example
  `node tests/core/core.test.js --only=floppy`.
- Another ROM: `node tests/core/core.test.js /path/to/other.img` or
  `PCE_ST_ROM=...`.
- The tests leave screenshots in `build/out/` (`desktop.png`, `color.png`,
  `click.png`, `floppy.png`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing build/out/pce_st_core.wasm` | The core has not been built: `scripts/build-core.sh`. |
| `cannot find emcc or .../emsdk_env.sh` | emsdk is not in `~/emsdk`: install it (step 2) or set `EMSDK_DIR`. |
| `WARNING: tested with b2e4b44` | The PCE clone is at another commit. It usually works, but the tested version is the one listed. |
| The page shows `Aborted(CompileError ... expected magic word)` | The server returned a 404 instead of the `.wasm`: the core was not built or `build/out/` does not exist. |
| `Failed to execute 'requestPointerLock'` or the mouse is not captured | You must click inside the screen; some browsers require the tab to have focus. |
| No sound | The browser requires a user gesture: press **Start** (it does not start by itself). Check that the speed is 1×. |
| Blank screen for a few seconds | Normal during EmuTOS boot (see above). |
| `Chrome/Chromium not found` in the tests | Set `CHROME=/usr/bin/chromium` (or your browser's path). |
| Chrome does not start in the tests inside a container | The client already uses `--no-sandbox`; if it still fails, check that there is a writable temporary directory. |
| Port in use | `node scripts/serve.js 9000`. |

## Repository layout

```text
core/
  st_glue.c          C glue: replaces PCE's main() and exports pce_st_*
  st_config.js       Builds the core's configuration text (Node and browser)
web/
  index.html, style.css      The page (jsA8E look: toolbar, themes, CRT screen)
  emulator_worker.js         Emulation worker (message dispatcher)
  js/app/                    User interface (ui.js), on-screen keyboard and joystick, entry point
  js/core/                   PCE_STApp (st_app.js), its proxy (app_proxy.js), keymap
  js/render/                 WebGL2 renderer with CRT filter, Canvas 2D fallback, shaders
  js/audio/                  AudioWorklet queue
  vendor/                    Font Awesome and fonts, served locally (no CDN)
scripts/
  build-core.sh      Builds PCE (clean copy) + st_glue.c -> build/out/
  serve.js           Static development server (no dependencies)
tests/
  core/              Core tests in Node + test floppy images
  browser/           Real-Chrome tests + minimal DevTools client
roms/emutos/         EmuTOS 1.4 (GPL) with its license and source link
implementation/      Notes, analysis and technical references
requirements.md      Project requirements and feasibility assessment
build/               Build output (not versioned)
```

## Documentation

- `implementation/NOTES.md`: status, decisions, findings and what is left.
  **Read it before planning** and update it after every improvement.
- `NOTICE.md` and `COPYING`: license and attributions.
- `implementation/CORE_API.md`: reference for the core's functions (`pce_st_*`).
- `implementation/WEB.md`: page architecture, the `PCE_STApp` API, run loop,
  rendering, input and UI.
- `implementation/jsA8E_integration.md`: analysis of jsA8E's shell and the
  phase 2 plan.
- `implementation/LIBRARY.md`: plan for the disk library (step 3).
- `requirements.md`: goal, scope, risks and open questions.

## License

GNU GPL version 2 (see `COPYING` and `NOTICE.md`). It includes code from PCE
(Hampa Hug) and PCE.js (James Friend), and the EmuTOS ROM (`roms/emutos/`, GPL).
