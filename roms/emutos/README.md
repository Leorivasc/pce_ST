# EmuTOS (default ROM)

`etos192us.img` is **EmuTOS 1.4**, the 192 KB version for the Atari ST, with
US language and keyboard. It is the ROM the emulator uses by default (loaded at
`0xFC0000`, 192 KB).

- Project: <https://emutos.sourceforge.io/>
- Binary package used:
  <https://sourceforge.net/projects/emutos/files/emutos/1.4/emutos-192k-1.4.zip>
- **Source code** (a GPL obligation; the project distributes it separately):
  <https://sourceforge.net/projects/emutos/files/emutos/1.4/emutos-src-1.4.tar.gz>
- SHA-256 of `etos192us.img`:
  `8fbbf8b44fc3e34281eaf8cda5265510e9af9ccda0e3e409111648060d244cfc`

## License

EmuTOS is distributed under the **GNU General Public License** (see
`license.txt`). It incorporates code from other projects published under GPL;
their authors are in `authors.txt`. `emutos-readme.txt` is the original one from
the package.

This directory is an unmodified copy of those files. If the ROM is replaced by
another version, update this file (version, source code URL and SHA-256).

## Other variants

The same package has 192 KB versions in other languages (`etos192de.img`,
`etos192fr.img`, ...) and 256 KB, 512 KB and 1024 KB versions. To use another
one, change `rom.file` in the core configuration.

## Atari TOS

Atari's original TOS ROMs are **not** included: they are copyrighted and not
freely distributable. If the user wants to use them, the user supplies them
(through the shell's local ROM library).
