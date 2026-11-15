# Core: `pce_st_*` reference

Source: `core/st_glue.c`. It is built with `scripts/build-core.sh` into
`build/out/pce_st_core.js` + `.wasm`. The functions are exported automatically:
the script exports every `pce_st_*` identifier that appears in the C file.

The module (`MODULARIZE`, factory `PCE_STCoreFactory`) also exposes `FS`,
`HEAPU8`, `UTF8ToString`, `stringToUTF8`, `lengthBytesUTF8`, `_malloc` and
`_free`.

## General rules

- **One machine per module instance.** The glue keeps the machine in C global
  variables; to have several machines, create several module instances
  (`await PCE_STCoreFactory()`), each with its own memory.
- **Order**: `pce_st_set_time` (optional) → `pce_st_init` → the rest. Before
  `pce_st_init` the ROM must be written into the module's file system
  (`M.FS.writeFile("/tos.rom", bytes)`), at the path the configuration names.
- **Time**: the core does not use the real clock to advance. Time is set by the
  caller (`step_*`). One clock unit is 1/8 000 000 s.
- **Strings**: functions that take a `const char *` expect a pointer to a UTF-8
  string allocated with `_malloc`.
- **`HEAPU8` changes** if memory grows (`ALLOW_MEMORY_GROWTH`): read `M.HEAPU8`
  again after calling the core; do not keep the reference.

## Creation and reset

| Function | Description |
|---|---|
| `int pce_st_init(const char *cfg)` | Creates the machine from the configuration text (PCE libini; see `core/st_config.js`). Returns 0 on success; 1 = already created, 2 = invalid configuration, 3 = `st_new` failed. |
| `void pce_st_reset(void)` | Hardware reset (`st_reset`). |
| `void pce_st_set_time(double secs)` | Sets the initial RTC/IKBD time (Unix seconds). From then on it advances **only with emulated time** and `localtime` returns UTC. A negative value uses the real time (the default). Call **before** `pce_st_init`. Essential for reproducible tests. |

## Stepping

| Function | Description |
|---|---|
| `int pce_st_step_frame(void)` | Advances until a video frame is complete. Returns 0 if it completed one, 1 if the machine stopped, −1 if it did not within 4 000 000 units (safety). Video and audio are ready on return. |
| `int pce_st_step_cycles(unsigned long n)` | Advances `n` clock units; only multiples of 16 are advanced (any remainder is ignored). Returns 0, or 1 if the machine stopped. |
| `double pce_st_clock_count(void)` | Clock units emulated since reset (8 000 000 = 1 s). |
| `unsigned pce_st_frame_count(void)` | Video frame counter. |

Stepping N frames or stepping the equivalent number of cycles gives the **same
state** (checked by hash). Frame rate: monochrome ≈ 71.1 Hz (≈ 112 448 units per
frame), color ≈ 60 Hz.

## Video

| Function | Description |
|---|---|
| `const unsigned char *pce_st_video_buf(void)` | Pointer (in WASM memory) to the RGB buffer, 3 bytes per pixel (R, G, B), contiguous rows. |
| `unsigned pce_st_video_width(void)` / `pce_st_video_height(void)` | Current size: 640×400 mono; 320×200 low-res color; 640×200 medium-res color. It changes by itself with the program's mode. |

The buffer is updated at the start of the vertical blank and holds the complete
image of the last frame. Reading from JS:

```js
const p = M._pce_st_video_buf(), w = M._pce_st_video_width(), h = M._pce_st_video_height();
const rgb = M.HEAPU8.subarray(p, p + w * h * 3);
```

A freshly created buffer (before the first frame) is all black.

## Audio

Mono, signed `int16`, 0 = silence, at `psg.sample_rate` (48000 by default).
PCE's PSG generates unsigned samples with zero at `0x8000`; the glue converts
them (`s ^ 0x8000`). The PSG stops completely while silent and delivers blocks of
512 samples: at the end of every step the glue **pads with zeros** up to
`cycles × rate / 8 000 000`, so the stream always follows emulated time
(±1 sample).

| Function | Description |
|---|---|
| `const int16_t *pce_st_audio_buf(void)` | Pending samples. |
| `unsigned pce_st_audio_count(void)` | How many there are (the queue holds up to 65 536). |
| `void pce_st_audio_clear(void)` | Empties the queue. **Call it after reading**, normally after every frame. |
| `unsigned pce_st_audio_rate(void)` | Sample rate. |
| `unsigned pce_st_audio_dropped(void)` | Samples discarded because the queue was full (must be 0). |

## Input

| Function | Description |
|---|---|
| `void pce_st_key(unsigned event, unsigned key)` | `event`: 1 = press, 2 = release. `key`: `pce_key_t` code (see below). |
| `unsigned pce_st_key_from_name(const char *name)` | Key code by name (`"a"`, `"Return"`, `"ESC"`, `"CtrlLeft"`, `"ShiftRight"`, `"Up"`, `"KP_Enter"`, ...). 0 if it does not exist. Resolves two cases PCE's table does not cover: `"i"` and `"ShiftRight"`. |
| `void pce_st_mouse(int dx, int dy, unsigned buttons)` | **Relative** motion (positive = right/down) and button state: bit 0 left, bit 1 right, bit 2 middle. It can be called without motion (0, 0) to change only the buttons. |

Available key names: see `web/keymap.js` (the ones the page uses) and PCE's
`src/drivers/video/keys.c`. The ST's Help and Undo are `End` and `PageDown`.

## Joystick

PCE has no joystick input of its own: it emulates one with the **numeric keypad**.
While that mode is on, `KP_8`/`KP_2`/`KP_4`/`KP_6` move the stick (`KP_7/9/1/3` are
the diagonals) and `KP_0` fires; the keypad no longer types digits.

| Function | Description |
|---|---|
| `void pce_st_set_keypad_joystick(unsigned mode)` | 0 = the keypad types as usual; 1 = joystick in port 1 (the standard joystick port); 2 = joystick in port 0 (shared with the mouse). |
| `unsigned pce_st_get_keypad_joystick(void)` | The current mode. |
| `unsigned pce_st_joystick_state(unsigned port)` | The IKBD's state for a port (0 or 1): bit 0 up, 1 down, 2 left, 3 right, 7 fire. Useful to test. |

Send the keypad keys with `pce_st_key` (names `"KP_8"`, `"KP_2"`, `"KP_4"`, `"KP_6"`,
`"KP_0"`). The mode is part of the machine's memory, so snapshots keep it; a new
machine starts with mode 0.

## Media

Floppies are mounted with PCE messages on files in the module's file system
(`M.FS`):

```js
M.FS.mkdir("/disks");
// 1. Eject first (saves the previous floppy to the file, if the guest modified it)
msg("disk.eject", "0");
// 2. Write the new image
M.FS.writeFile("/disks/fd0.st", bytes);
// 3. Insert (into the drive of the last eject; 0 = A:, 1 = B:)
msg("disk.insert", "/disks/fd0.st");
```

**Order matters**: if you write the file before ejecting and the guest had
modified the previous floppy, PCE overwrites your new image with the old one
(there is a test covering this). Image formats: `.st` (tested). `.msa`, `.dim`
and PCE's stream formats are in the code but untested.

| Function | Description |
|---|---|
| `int pce_st_msg(const char *msg, const char *val)` | Sends a PCE message. Returns 0 if accepted. Examples: `disk.eject`, `disk.insert`, `emu.pause`, `emu.reset`. `val` may be `NULL`. See `src/arch/atarist/msg.c`. |
| `int pce_st_disk_flush(unsigned drive)` | Saves floppy A: (0) or B: (1) to its file **now**, without ejecting it. 0 = saved or no changes; 1 = no disk or failed. PCE only saves by itself on eject or reset. |
| `int pce_st_disk_modified(unsigned drive)` | 1 if the guest has written since the last save. |

Guest writes to an emulated floppy are slow (creating a folder takes ~1200
frames). After `pce_st_disk_flush`, read the file with `M.FS.readFile`.

## State and debugging

| Function | Description |
|---|---|
| `unsigned pce_st_peek8(unsigned long addr)` | Reads a byte from the bus (24 bits). |
| `void pce_st_poke8(unsigned long addr, unsigned val)` | Writes a byte to the bus. Useful, for example, to program the PSG: `poke8(0xFF8800, reg); poke8(0xFF8802, value)`. |
| `double pce_st_reg(const char *name)` | CPU register by name (`"pc"`, `"sr"`, `"d0"`..`"d7"`, `"a0"`..`"a7"`, `"sp"`, `"usp"`...). −1 if it does not exist. |
| `unsigned long pce_st_ram_size(void)` | RAM size in bytes. |
| `const char *pce_st_state_hash(void)` | FNV-1a digest (16 hex digits) of RAM, registers, frame counter, clock and video. Two identical runs give the same value. Static string: copy it before calling again. |

Useful memory map: RAM from 0; ROM at `0xFC0000`; PSG `0xFF8800/02`; video
registers `0xFF82xx`; MFP `0xFFFA00`; keyboard/mouse (ACIA) `0xFFFC00`.

## Snapshots

There is no dedicated function: the **whole WASM memory** is dumped
(`M.HEAPU8`, ~17 MB, ~240 KB with deflate level 1, ~42 ms) and restored into
another instance created with the same configuration (`HEAPU8.set(copy)`).
Conditions:

- The target instance is initialized with `pce_st_init` and **the same
  configuration** before restoring; `HEAPU8.length` must match.
- Files in JS's file system (floppy images) are not in that memory: they must be
  recreated at the same paths before restoring.
- Not tested with memory that has grown.

## Configuration

`core/st_config.js` (`PCE_STConfig.build(options)`) generates the libini text.
Options (default values):

| Option | Default | Notes |
|---|---|---|
| `model` | `"st"` | `"st"` or `"mega"`. |
| `mono` | `true` | Monochrome 640×400 or color 320×200. |
| `ramKB` | `1024` | RAM in KB. |
| `romFile` | `"/tos.rom"` | Path in the module's file system. |
| `romKB` | `192` | ROM size. |
| `romAddress` | `0xfc0000` | ROM address (TOS 1.x). |
| `sampleRate` | `48000` | PSG sample rate. |

Fixed values: 68000 CPU at speed 1, `fastboot = 1` (no memory test), RTC enabled,
`frame_skip = 0` (every frame is computed), `null` terminal and PSG.

## What is not linked from PCE

`src/arch/atarist/main.c` (replaced by `st_glue.c`, which defines the symbols
`par_sim`, `par_cfg`, `par_mon`, `par_terminal`, `par_verbose`, `sim_stop` and
`st_log_deb`), SDL and the browser main loop. The link step uses
`--wrap=time --wrap=localtime` for the fixed time.
