# Web page (step 1): architecture and protocols

Files: `web/index.html`, `web/main.js`, `web/worker.js`,
`web/audio-worklet.js`, `web/keymap.js`; served by `scripts/serve.js`.
It is the skeleton that precedes jsA8E's shell (phase 2, step 2); when it is
replaced by the shell, this protocol is the starting point of the `PCE_STApp`
adapter.

## Overview

```text
Main thread (main.js)                       Worker (worker.js)
  interface, keyboard, mouse   postMessage    loads the WASM core (pce_st_core)
  Pointer Lock              ───────────────►  loop: advances frames at pace
  AudioContext + worklet    ◄───────────────  draws the video (OffscreenCanvas)
        ▲                      state          sends audio to the worklet
        │ MessagePort (Int16Array)                 │
        └──────────────── AudioWorklet ◄───────────┘
```

- Emulation and drawing happen **in the worker**. The `<canvas>` is handed over
  with `transferControlToOffscreen()` and from then on can only be sized with CSS
  on the main thread; the worker sets `canvas.width/height`.
- Audio goes through a `MessageChannel` created on the main thread: one end is
  given to the worklet (message `{port}`) and the other to the worker
  (`audioPort` in `init`). The worker sends transferred `Int16Array`s, without
  going through the main thread.
- The `.wasm` is located with `locateFile` (`../build/out/`).

## Worker loop

On every tick (`setTimeout(…, 1)`):

1. `dt` = real time since the previous tick, capped at **100 ms** (as in PCE;
   avoids the catch-up spiral).
2. Speed `N` (1, 2, 4): `budgetMs += dt × N`; while `budgetMs > 0`: call
   `pce_st_step_frame()` and subtract that frame's emulated time. If a tick takes
   more than 50 ms of work, it is cut short. If the leftover budget exceeds
   200 ms, it is discarded.
3. **Maximum** speed (`0`): advance frames for 12 ms of work.
4. Draw the last frame if it changed, send the audio (**only at 1×**; at other
   speeds it is discarded) and, every 500 ms, send `stats`.

## Main thread → worker messages

| `type` | Fields | Effect |
|---|---|---|
| `init` | `rom` (ArrayBuffer), `mono` (bool), `sampleRate`, `canvas` (OffscreenCanvas, first time only), `audioPort` (MessagePort, first time only), `autostart` | Creates a new core instance with that configuration (discarding the previous one) and, if `autostart`, starts. Replies `ready` and `running`. |
| `run` | `run` (bool) | Pauses or resumes. Replies `running`. |
| `reset` | — | Hardware reset. |
| `speed` | `speed` (1, 2, 4 or 0 = maximum) | Changes the speed. |
| `key` | `code` (`KeyboardEvent.code`), `down` (bool) | Key. Translated with `keymap.js`; unmapped codes are ignored. |
| `mouse` | `dx`, `dy`, `buttons` | Relative motion and buttons (bit 0 left, 1 right, 2 middle). |
| `mount` | `drive` (0/1), `bytes` (ArrayBuffer) | Mounts a `.st` image (eject, write, insert). Replies `mounted`. |
| `flush` | `drive` | Saves the floppy and returns its image. Replies `floppy`. |
| `screenshot` | `id` | Returns the current video. Replies `screenshot`. |
| `peek` | `id`, `addr`, `length` | Reads ST memory. Replies `memory`. |
| `poke` | `addr`, `value` | Writes a byte (e.g. PSG registers). |

## Worker → main thread messages

| `type` | Fields |
|---|---|
| `ready` | — (the core is created) |
| `running` | `running` |
| `stats` | `fps` (emulated frames per real second), `speed` (emulated time / real time), `width`, `height`, `clock` (1/8 MHz units) |
| `videoSize` | `width`, `height` (when the mode changes) |
| `mounted` | `drive`, `rc` (0 = success) |
| `floppy` | `drive`, `rc`, `bytes` (ArrayBuffer of the image, or `null` if there is no disk) |
| `screenshot` | `id`, `width`, `height`, `rgb` (RGB ArrayBuffer, 3 bytes/pixel) |
| `memory` | `id`, `bytes` |
| `log` | `text` (core output; only stored if `PCE_ST_DEBUG` exists) |
| `error` | `message` |

## AudioWorklet (`audio-worklet.js`)

Processor `pce-st-audio` (mono). Circular queue of 2^17 samples (~2.7 s).

- It starts playing with **40 ms** accumulated; if the queue runs dry it outputs
  silence, counts an "underrun" and waits for the 40 ms again.
- If the queue exceeds **250 ms**, it discards the oldest samples down to
  **80 ms** (`dropped`), so latency does not build up.
- Every 0.5 s it reports `{queued, underruns, dropped, peak}` to the main
  thread; `peak` is the maximum absolute value played since the previous report
  (0 = exact silence, 1 = full scale). A healthy queue is around 1500–2200
  samples.

## Input (`main.js`, `keymap.js`)

- Keyboard: `keydown/keyup` with `event.code`; repeats are ignored (`e.repeat`;
  the ST repeats in software); `preventDefault` only for mapped keys. Active if
  the screen has focus or the mouse is captured. When the window loses focus or
  the mouse is released, all pressed keys and buttons are released.
- Mouse: click on the screen → `requestPointerLock({unadjustedMovement: true})`
  (retrying without that option). With the pointer captured, `mousemove` sends
  `movementX/Y`; `mousedown/up` send the buttons (0 → bit 0, 2 → bit 1,
  1 → bit 2). The screen's context menu is disabled.
- `ShiftLeft/Right`, `ControlLeft/Right` and `AltLeft/Right` are sent
  separately. The ST has no Page Up, Num Lock or Windows keys.

## Debugging API: `window.PCE_ST_DEBUG`

Meant for tests and for the future automation API.

| Member | Description |
|---|---|
| `state()` | `{running, mouseSent, stats, audio, video, audioState}` |
| `send(msg, transfer?)` | Sends a message to the worker. |
| `screenshot()` | Promise of `{width, height, rgb: Uint8Array}` with the current video (the worker's canvas cannot be read from the main thread). |
| `peek(addr, length)` | Promise of a `Uint8Array` with ST memory. |
| `readFloppy(drive)` | Promise of `{rc, bytes}`: flushes the floppy and returns the image **without downloading it**. |
| `start()` | Starts the machine (same as **Start**). |
| `log` | Core output (array of strings). |

A URL with `?autostart` starts without pressing **Start** (useful for tests;
headless Chrome's audio is unlocked with `--autoplay-policy`).

## Server (`scripts/serve.js`)

Static server without dependencies, on `127.0.0.1` only. It serves just
`/web/`, `/core/st_config.js`, `/build/out/` and `/roms/` (anything else returns
404; protected against paths with `..`). Correct MIME types for `.wasm`.
Headers `Cache-Control: no-store` and `Cross-Origin-Opener-Policy`/
`Embedder-Policy`/`Resource-Policy` (they leave the page isolated, needed later
for `SharedArrayBuffer`). It can be imported
(`require("./scripts/serve.js").start(0)` returns the server on a free port) and
the browser tests use it.

## Browser tests (`tests/browser/`)

`cdp.js` is a minimal client for Chrome's DevTools protocol, with no
dependencies (hand-written WebSocket): it launches headless Chrome with
`--remote-debugging-port=0`, opens pages, evaluates JS, sends keyboard and mouse
with `Input.dispatch*Event` and takes screenshots. The suite
(`browser.test.js`) covers: real time and audio, turbo, keyboard, end-to-end
audio (silence, tone, silence), pause, color monitor, floppy mounting, pointer
capture and mouse motion with the pointer captured.

Known traps when writing tests:

- A freshly created video buffer is **all black**: "many dark pixels" is not
  enough to say the desktop is drawn (it is dotted, ~48 % dark).
- The desktop takes ~18 emulated seconds: use maximum speed and go back to 1×.
- Key presses must last several frames (≥ 80 ms) for GEM to see them.
- GEM selects on mouse button **release**, not on press.
