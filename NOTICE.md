# Copyright notices and licenses

PCE_ST is distributed under the **GNU General Public License, version 2** (text
in `COPYING`). It includes and is based on the following works, all under GPL v2
or compatible:

## PCE

Emulator by Hampa Hug, <http://www.hampa.ch/pce/>. Copyright (C) Hampa Hug
<hampa@hampa.ch> (the source files indicate periods such as 2005–2020 and
2011–2022; the startup banner says 2011–2025). License: GPL v2. Based on version
`20250420-cc0c583c`.

PCE_ST does **not include** PCE's code in this repository: `scripts/build-core.sh`
builds it from an external clone (the PCE.js fork) and links the result into
`build/out/pce_st_core.wasm`. Anyone who distributes that binary must offer the
corresponding PCE source code and keep these notices.

## PCE.js

Browser port of PCE (Emscripten) by James Friend, <https://jamesfriend.com.au/>.
Copyright (C) James Friend. License: GPL v2. Fork used:
<https://github.com/Leorivasc/pce>, commit `b2e4b44`.

## EmuTOS

Free operating system for the Atari ST, <https://emutos.sourceforge.io/>.
Version 1.4 (`roms/emutos/etos192us.img`). License: GPL (see
`roms/emutos/license.txt`); authors in `roms/emutos/authors.txt`; source code at
<https://sourceforge.net/projects/emutos/files/emutos/1.4/emutos-src-1.4.tar.gz>.
It contains Digital Research code (BDOS, VDI, AES, desktop) released under GPL.

## Project code

`core/`, `web/`, `scripts/` and `tests/` are this project's code, under GPL v2.
`core/st_glue.c` is a derivative work of PCE's `src/arch/atarist/main.c` (same
symbols, same license).

## Pending

When code from jsA8E is copied (the shell, phase 2), record here its authorship,
its license (GPL v2) and the origin commit (`30fb949`), leaving no references to
jsA8E/A8E in the copied code (decision recorded in `implementation/NOTES.md`).
