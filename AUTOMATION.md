# PCE_ST automation

A deterministic, headless way to drive the emulator from scripts, tests and AI tools
(through MCP). It runs the same WASM core as the page, in Node, with no browser:

```text
automation/headless.js     the grouped API (system, media, input, debug, artifacts)
automation/mcp_server.js   MCP server over stdio, wrapping that API
tests/automation/          tests of both (Node, ~35 s)
```

Requirements: the core built (`scripts/build-core.sh`) and Node 18+. EmuTOS is built
in (`roms/emutos/`).

## Determinism

The machine **only advances when an action asks for time** (`system.run`, a key `tap`,
`typeText`, `click`, `runUntil...`). The clock is fixed at 2026-01-01 12:00 UTC, so two
runs of the same script end in the same state (same `hash`). Pass `time` to `boot` to
change the clock (`"real"` for the real one).

Durations are `{ frames }`, `{ seconds }`, `{ ms }`, `{ cycles }` (8 000 000 per
second), or a string: `"2s"`, `"500ms"`, `"3frames"`, `"1000cycles"`. A monochrome frame
is 112 448 cycles (about 71 Hz).

## From Node

```js
const { createHeadlessAutomation } = require("./automation/headless");
const auto = await createHeadlessAutomation({ cwd: process.cwd(), confinePaths: false });
const api = auto.api;
await api.system.boot();                                    // EmuTOS, monochrome, 1 MB
api.debug.runUntilStable({ stableFrames: 60, minDarkPercent: 30 });   // the desktop
api.media.mountFloppy({ drive: "A", path: "game.st" });
api.input.moveMouse({ dx: -300, dy: -170 });
api.input.click({ double: true });
api.artifacts.captureScreenshot({ out: "desktop.png" });
```

`confinePaths: true` restricts every path an action reads or writes to `cwd` (symbolic
links included); the MCP server turns it on by default.

## Actions

| Group | Action | Arguments → result |
|---|---|---|
| system | `boot` | `{ model, mono, ramKB, rom: {path\|base64}, time }` → state. Restarts the machine; mounted floppies stay. |
| | `reset` | Hardware reset. |
| | `run` | a duration → `{ advancedCycles, state }` |
| | `getState` | `{ booted, config, rom, clock, seconds, frame, video, hash, registers, floppies {A,B}, joystick, keysDown }` |
| | `getCapabilities` | versions, formats and the action list |
| | `getLog` | the core's recent messages |
| media | `mountFloppy` | `{ drive: "A"\|"B", path\|base64\|bytes, name }`. `.st` as is, `.msa` converted, `.prg` wrapped in a generated floppy. |
| | `buildFloppy` | `{ files: [{name, path\|base64}], label, drive }` builds a 720K floppy (the "work files" disk; names like `SUB/FILE.TXT` make folders); mounts it if `drive` is given, else returns it. |
| | `ejectFloppy`, `flushFloppy` | `{ drive }` |
| | `readFloppy` | `{ drive, out }` → image bytes (or written to `out`) with `sha256`; includes the guest's changes. |
| | `listFiles` | `{ drive, folder }` → label and entries (FAT12). |
| | `readFile` | `{ drive, path, asText }` |
| input | `key` | `{ key: "KeyA"\|"Enter"\|PCE name, action: "tap"\|"press"\|"release", hold, after }` |
| | `typeText` | `{ text, hold, gap }` (US layout; Shift is handled) |
| | `mouse` | `{ dx, dy, buttons, after }` relative |
| | `moveMouse` | `{ dx, dy }` total, in small steps |
| | `click` | `{ button: "left"\|"right", double, hold, gap }` |
| | `joystick` | `{ up, down, left, right, fire, hold }` port 1 (turns the joystick mode on) |
| | `releaseAll` | releases keys and buttons |
| debug | `peek`, `poke` | `{ address, value }` |
| | `readMemory`, `writeMemory` | `{ address, length }` / `{ address, base64\|bytes }` |
| | `getRegisters`, `getStateHash` | |
| | `runUntilMemory` | `{ address, value, mask, maxFrames }` → `{ matched, frames }` |
| | `runUntilStable` | `{ stableFrames, maxFrames, minDarkPercent }`: waits for a still screen. The mono EmuTOS desktop is ~48 % dark. |
| artifacts | `captureScreenshot` | `{ out }` → PNG, `width`, `height`, `sha256`, `darkPixelPercent` |
| | `captureAudio` | a duration, `{ out }` → WAV, `peak`, `rate` |
| | `saveSnapshot`, `loadSnapshot` | `.pcestsnap` bytes, the same format as the page's snapshots |

Errors are exceptions with a `code` (`not_booted`, `bad_arguments`, `no_floppy`,
`not_found`, `path_denied`, ...).

## MCP

```text
node automation/mcp_server.js [--cwd DIR] [--rom FILE] [--allow-any-path] [--no-boot]
```

The server speaks MCP over stdio (one JSON message per line; protocol versions
2025-11-25 to 2024-11-05) and boots the machine at start-up. Tools:

- `get_capabilities`: versions, formats, and the list of actions per group.
- `get_system_state`: the machine summary.
- `call_automation`: `{ domain, action, args }` for any action above.

Binary results come back as `{ byteLength, base64 }`; `captureScreenshot` also returns
an image block. Tool errors set `isError` and carry `structuredContent.error.code`;
unknown domains/actions are protocol errors (-32602) that list the valid names. Calls
are queued: the machine is never driven by two at once. Paths are confined to `--cwd`
unless `--allow-any-path`.

Registering it in a client (for example Claude Code, `.mcp.json` at the project root):

```json
{ "mcpServers": { "pce-st": { "command": "node", "args": ["automation/mcp_server.js", "--cwd", "."] } } }
```

## Not covered (yet)

Driving the page that is open in a browser (the MCP server runs its own headless
machine), breakpoints and single-stepping (PCE has a debugger the glue does not
export yet), `.dim`/ACSI images.
