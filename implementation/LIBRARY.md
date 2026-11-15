# Library (phase 2, step 3): plan

Status: **step 3 done** (3a-3d, 2026-11-15): library core, panel, ROM library,
remembered workspace, save-back of guest changes, FAT12 reader and contents view,
MSA support. Left for later: `.dim` images, ACSI images, remote sync, automation. This
document records what was found in jsA8E's library, what carries over, what has to
change for the ST, and the order of work. Update it as the steps are done.

## What jsA8E has (origin commit `30fb949`)

| Piece | Size | Role |
|---|---|---|
| `js/core/disk_library.js` | 2001 lines | The library: entries with **revisions**, a preferred revision, **folders**, a recoverable **trash**, mounts (slot per drive), dirty working copies flushed back as new revisions, storage in **IndexedDB** (with an in-memory fallback), package export/import, tombstones and metadata for sync, integrity checks. |
| `js/core/library_package.js` | 721 lines | The portable package: `library.json` schema v1 plus content-addressed blobs (SHA-256), validation and size limits, conflict handling. |
| `js/core/library_archive.js` | 300 lines | A dependency-free ZIP codec (method 0, stored) used by the package. |
| `js/core/atr_inspector.js` | 355 lines | Read-only inspection of a disk image's file system (the ST equivalent is a FAT12 reader). Optional for the library. |
| `js/app/disk_library_ui.js` | 1359 lines | The panel: mounted-devices strip, folder navigation, upload/drop, search, filters, per-file actions (download, move, delete, revisions, inspect), trash, package import/export. |
| `js/core/rom_library.js` | 250 lines | User ROMs kept in IndexedDB. |
| `js/app/remote_*.js` | ~1300 lines | Sync with a remote library and workspaces (OnlineDrive). |
| `js/core/hostfs.js`, `hdevice.js` | ~1350 lines | The `H:` working-files device. Tied to the 8-bit Atari's CIO. |

jsA8E also has ~480 lines of Node tests for the library, package and archive that
load the modules in a `vm` context with injected callbacks (no browser needed).

## Why it ports well

The library does **not** know the emulator. It receives three callbacks:

```js
library = DiskLibrary.create({
  mountDisk(bytes, name, slot)  -> { imageIndex, deviceSlot },
  unmountDisk(slot),
  getDiskImageBytes(imageIndex) -> Uint8Array,
});
```

For the ST, `mountDisk` maps to `app.mountFloppy`, `unmountDisk` to
`app.unmountFloppy`, and `getDiskImageBytes` to `app.flushFloppy` (which returns the
guest's changes). Slots are `0` (A:) and `1` (B:). Everything else (folders,
revisions, trash, packages) is independent of the machine.

## What has to change

1. **Formats**: `atr`/`xex` become the ST's floppy images, `st` first (`msa` and `dim`
   next, once mounting them is tested; ACSI hard-disk images later). `xex` (a loose
   executable) has no ST equivalent in PCE, which only sees disks.
2. **Blank disk**: `createBlankAtr` becomes a blank FAT12 floppy (the 720K image that
   `tests/core/stimage.js` already builds).
3. **Slots**: 8 device slots (D1-D8) become 2 floppy slots (A:, B:). The UI's drive
   columns change accordingly.
4. **Naming**: the package format, the IndexedDB database and every global become
   `PCE_ST` names (`pce-st-library-export`, `pce_st_disk_library`, ...), with a new
   file extension for packages. No compatibility with jsA8E packages is needed
   (the projects are independent).
5. **Inspector**: `atr_inspector.js` is replaced by a FAT12 reader (list the files
   on a floppy image); it also supports `mounted` diagnostics. Optional at first.
6. **ZIP of floppies**: jsA8E opens ZIP files containing an image through
   [fflate](https://github.com/101arrowz/fflate), loaded from a CDN. That is an
   external dependency; it has to be vendored (MIT license) or replaced by the
   project's own stored/deflate reader (the package ZIP codec only needs method 0).
7. **Where it runs**: jsA8E runs the library in the worker. For the ST, IndexedDB is
   available on the main thread, and the library only exchanges bytes with the
   machine, so it is simplest to run it on the **main thread** and keep the worker
   free for emulation. (Revisit for remote sync and automation, which also need it
   headless.)
8. **Layout**: the Work and Development layouts of jsA8E put the library in a left
   column next to the screen with a draggable splitter. The page's `emulation`
   layout stays as it is; the other layouts come with the panel.

## Order of work

1. **3a. Library core**: copy and adapt `library_archive.js`, `library_package.js` and
   `disk_library.js` (naming, formats, slots, blank floppy), and port their Node
   tests. No UI yet. Done when the ported tests pass and a floppy added to the
   library can be mounted in a machine in the browser through the proxy.
2. **3b. Library panel**: layout schemes with a left column and splitter; the panel
   (mounted devices A:/B:, folders, upload and drag-and-drop, search, per-file
   actions, trash); `.st` support first.
3. **3c. Persistence of the rest**: ROM library (IndexedDB), remembering the mounted
   floppies across reloads (the "workspace"), save-on-eject of the guest's changes.
4. **3d. Content**: the FAT12 reader for the library's file listing and integrity
   check; `.msa`/`.dim` (after testing them in the core); package import/export UI.
5. **Later (step 4 and beyond)**: remote sync, automation/MCP, HostFS-equivalent
   (build a FAT image from uploaded files), snapshots UI.

## Step 3a: what was done

- Ported `library_archive.js`, `library_package.js` and `disk_library.js` to
  `web/js/core/` with PCE_ST names: globals `PCE_STLibraryArchive`,
  `PCE_STLibraryPackage`, `PCE_STDiskLibrary`; IndexedDB `pce_st_disk_library`;
  package format `pce-st-library-export`, extension `.pcest`.
- Formats: `st` (a floppy image) and `prg` (a loose program). Workspace devices are
  `A` and `B`; two slots (0, 1).
- `web/js/core/st_image.js` (`PCE_STImage`): `createFloppy({label, files})` builds a
  720K FAT12 floppy (names are made 8.3), and `verify(bytes)` walks the file system
  and checks every cluster chain (this is the library's integrity check and the
  start of the FAT12 reader of step 3d).
- A `.prg` entry is mounted as a generated floppy with the program in its root
  directory (the ST has no loose-executable loading, like jsA8E's XEX conversion);
  the entry reports `converted: true` and downloads as `NAME.ST`.
- Library callbacks may now be asynchronous (the machine is in a worker):
  `getDiskImageBytes` can return a promise and `onDiskMediaChanged` returns one.
  The image index of a mounted floppy is its drive number.
- `ui.js` creates the library on the main thread and exposes it as
  `window.PCE_ST_LIBRARY` (no panel yet).
- Tests: `tests/library/` (`library_archive`, `library_package`, `disk_library`,
  `st_image`, run with `node tests/library/<name>.test.js`) and one browser test.
  The archive test has its own fixture (`tests/library/fixtures/`).
- Not ported yet: the API-parity test (it compares the UI's calls with the library;
  it returns with the panel).

## Step 3b: what was done

- `web/js/app/disk_library_ui.js` (`PCE_STDiskLibraryUI`) is the panel, ported with
  two drive columns (A:, B:), `.st`/`.prg` filters and blank-floppy creation. The
  floppy-contents view (it was the ATR inspector's) was left out: it returns in 3d
  on top of a FAT12 reader. Remote sync buttons were left out too.
- Layout schemes `emulation` and `work` (a `development` scheme has nothing to show
  yet); left column plus splitter; phone sheet. State in `localStorage`.
- Browser tests: layout switch, upload, mounting in A: from the checkbox, search,
  trash, splitter drag, and the phone sheet.
- Splitter note: pointer move/up listeners go on `window` (listeners on the
  splitter itself did not receive the events during a drag in headless Chrome).

## Step 3c: what was done

- **ROM library** (`web/js/core/rom_library.js`, `PCE_STRomLibrary`, IndexedDB
  `pce_st_rom_library`): ROMs loaded with the ROM button are kept by name (192K
  only). A **ROM** selector in the secondary toolbar chooses between the built-in
  EmuTOS and the stored ROMs (the machine restarts); the choice is remembered in
  `localStorage` (`pce_st_rom_choice`) and used at startup. A button removes the
  selected stored ROM. Without IndexedDB the library works in memory.
- **Workspace**: after `library.init()` the page calls `restoreMounts()`, so the
  floppies that were in A:/B: are mounted again after a reload.
- **Toolbar floppy button** now goes through the library: the file is added (or, if
  the name exists in the root folder, becomes a new revision) and mounted in A:.
  It accepts `.st` and `.prg`.
- **Saving the guest's changes**: the worker reports `modified` per floppy (in
  every state message while there are unsaved changes, so a write right after a
  save is not missed). The page waits 1.5 s and calls
  `library.onDiskMediaChanged(slot)`, which pulls the image through
  `flushFloppy` and stores it as a new revision. The library also pulls from the
  machine before unmounting, downloading, exporting or replacing an entry
  (`pullFromMachine` inside `flushEntry`), and on `pagehide` (best effort).
- A floppy image read in the middle of a guest write can be a partial state; the
  last state is always saved afterwards.
- Tests: ROM keep/choose/remove across a reload; workspace restore; same-name open
  adds a revision; and an end-to-end test where the guest creates a folder on a
  mounted floppy (Ctrl+N in the desktop) and the library ends up holding it.
  The test page helper now empties IndexedDB on close (`close(true)` keeps data).

## Step 3d: what was done

- **FAT12 reader** (`PCE_STImage.openVolume`): lists any directory (root or by
  cluster), reads files through their cluster chains, exposes the volume label.
- **Contents view** in the panel: a *View the files on the floppy* button on every
  entry opens a read-only view with folder navigation (up button, double click),
  file sizes, types, preview (text or hex dump, first 8 KB) and per-file download.
  It works for `.prg` entries too (their generated floppy).
- **MSA**: `PCE_STImage.decodeMsa` (RLE, both sides, partial track ranges) converts
  `.msa` to a raw `.st` when a file is uploaded, dropped or opened with the
  toolbar button; the library only ever stores `.st` and `.prg`. Tested against a
  test encoder in Node and through the panel in Chrome.
- **`.dim` is not supported** (its header is not documented in this repository and
  there is no sample to test with); add it with a converter like MSA's when a
  real image is available.
- **Packages**: export/import through the panel is covered by a browser test.

## Decisions

- Package extension `.pcest`, format `pce-st-library-export`.
- Loose `.PRG` programs are supported by wrapping (see above).
- ACSI hard-disk images are left for after the floppies work.

## Open questions (settled; kept for history)

- Package file extension and format name (proposal: `.pcest`, format
  `pce-st-library-export`).
- Whether loose `.PRG` programs should be supported by wrapping them in a generated
  floppy image (a FAT12 writer would be needed).
- Whether ACSI hard-disk images belong in the first version of the library.
