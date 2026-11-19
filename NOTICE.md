# Copyright notices and licenses

PCE_ST is distributed under the **GNU General Public License, version 2** (text
in `COPYING`). It includes and is based on the following works, all under GPL v2
or compatible:

## PCE

Emulator by Hampa Hug, <http://www.hampa.ch/pce/>. Copyright (C) Hampa Hug
<hampa@hampa.ch> (the source files indicate periods such as 2005–2020 and
2011–2022; the startup banner says 2011–2025). License: GPL v2. Based on version
`20250420-cc0c583c`.

PCE's source code **is included** in this repository, in `third_party/pce/`
(added with `git subtree` from the PCE.js fork, commit `b2e4b44`, on 2026-11-19),
with its original copyright notices. `scripts/build-core.sh` compiles it and
links the result into `build/out/pce_st_core.wasm`. Changes made by PCE_ST to
those files are listed in `implementation/NOTES.md` ("Patches to PCE"). Anyone
who distributes the binary must offer the corresponding source code (this
repository at the same commit) and keep these notices.

## PCE.js

Browser port of PCE (Emscripten) by James Friend, <https://jamesfriend.com.au/>.
Copyright (C) James Friend. License: GPL v2. Fork used:
<https://github.com/Leorivasc/pce>, commit `b2e4b44`, vendored in
`third_party/pce/`.

## EmuTOS

Free operating system for the Atari ST, <https://emutos.sourceforge.io/>.
Version 1.4 (`roms/emutos/etos192us.img`). License: GPL (see
`roms/emutos/license.txt`); authors in `roms/emutos/authors.txt`; source code at
<https://sourceforge.net/projects/emutos/files/emutos/1.4/emutos-src-1.4.tar.gz>.
It contains Digital Research code (BDOS, VDI, AES, desktop) released under GPL.

## Font Awesome Free

Icons of the interface, `web/vendor/fontawesome/` (version 6.5.1,
<https://fontawesome.com>). Icons: CC BY 4.0; fonts: SIL OFL 1.1; code: MIT. See
`web/vendor/fontawesome/LICENSE.txt`.

## Exo 2 and Roboto Condensed

Fonts of the interface, `web/vendor/fonts/` (Latin subsets, from Google Fonts).
License: SIL Open Font License 1.1.

## CRT shader

`web/js/render/shaders/crt.frag.glsl` is based on the CRT shader by Timothy
Lottes (public domain), adapted in jsA8E and used here.

## Project code

`core/`, `web/`, `scripts/` and `tests/` are this project's code, under GPL v2.
`core/st_glue.c` is a derivative work of PCE's `src/arch/atarist/main.c` (same
symbols, same license).

## Code originally from jsA8E

Parts of the shell come from jsA8E (origin commit `30fb949`, GPL v2, by Leo Rivas,
based on A8E by AnimaInCorpore and Sascha Springer): the page structure and CSS
(`web/index.html`, `web/style.css`, `web/assets/leds.png`), the CRT vertex and
fragment shaders (`web/js/render/shaders/`), and the logic and structure of the
user interface (themes, screen sizing, fullscreen, run/pause handling, mobile
tools), reworked for the ST. The list of what was copied and what was left out is
in `implementation/NOTES.md` ("Copied from jsA8E"). No reference to the original
project remains in the code, by decision of the project.
