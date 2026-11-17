# CLAUDE.md

PCE_ST is an Atari ST emulator for the browser (PCE core compiled to WebAssembly,
JavaScript shell). It already has a test suite (about 90 tests in plain Node, no
framework). The goal is to **keep improving testing gradually**, without stopping
feature work and without rewriting what already works.

Read `implementation/NOTES.md` before planning and update it after every
improvement. `README.md` has the full setup and troubleshooting.

## Project rules

- **Everything that goes into the repository is in English**: documentation, UI
  text, messages, code comments, test names and commit messages. We may talk in
  another language.
- **No external dependencies** in the project's code. Use Node's standard library
  and what is already in the repo. There is no `npm install` step.
- **Compatibility fixes are generic.** Never patch for one application or game.
- **Never push or merge** unless I ask.
- Prefix for names, globals and storage keys is `PCE_ST` / `pce_st_`. No reference
  to jsA8E/A8E may be introduced.

## Project commands

Prerequisite: the core must be built (`scripts/build-core.sh`, about 30 s; needs
emsdk and the PCE clone, see `README.md`). Run everything from the repo root.

| Suite | Command | Time |
|---|---|---|
| Core in Node (22 tests) | `node tests/core/core.test.js` | ~30 s |
| Library (13 files) | `for t in library_archive library_package disk_library st_image snapshot_codec gamepad remote_workspace remote_library remote_library_metadata remote_library_tombstones remote_library_prg_blobs stx_library stx_convert; do node tests/library/$t.test.js \|\| exit 1; done` | seconds |
| Automation API (13 tests) | `node tests/automation/headless.test.js` | ~85 s |
| MCP server | `node tests/automation/mcp.test.js` | ~4 s |
| Page in real Chrome (41 tests) | `node tests/browser/browser.test.js` | ~2 min |

- **One test:** `--only=<part of its name>`, for example
  `node tests/browser/browser.test.js --only="ROM library"`.
- **Everything:** run the five suites above in order; stop at the first failure.
- **Quick loop:** if you only touched the library or `web/js/core/*`, the library
  suite is usually enough while working; run everything before saying you are done.
- Browser tests need Chrome or Chromium (`CHROME=/path/to/browser` if it is not on
  the `PATH`).

If these commands don't work or tests are missing, tell me instead of guessing.

## Core rule: leave it better than you found it

- **New code** must come with tests in the same change.
- **Code you modify** gets tests for the behavior you touched, even if it had none before.
- **Code you don't touch:** leave it alone. Do not add tests or refactor
  unrelated code unless I ask.
- Some things cannot be tested here (real touch devices, Firefox, Safari, the CRT
  filter on a real GPU). When your change depends on one of them, say what was not
  verified in your summary and in `NOTES.md` ("Not verified").

## Bugs: regression test first

1. Write a test that reproduces the bug and confirm it **fails**.
2. Fix the code.
3. Confirm the test passes and the rest of the suite still passes.

## Before refactoring untested code

1. First write tests that capture the **current** behavior (even if it looks odd).
2. Confirm they pass **before** changing anything.
3. Refactor and confirm they still pass.
4. If you find behavior that looks like a bug, report it. Don't silently "fix" it during a refactor.

## What a good test looks like here

- Test behaviors: happy path, edge cases (0, empty, exact limits), invalid input.
- Arrange / Act / Assert, one behavior per test, descriptive names (in English).
- Assert concrete expected values with `assert.strictEqual(total, 180)` or
  `assert.deepStrictEqual(...)`, not just truthiness (`assert.ok(x)`, `x !== undefined`).
- Use Node's built-in `assert` (`node:assert/strict` in new files) and the existing
  harnesses (`tests/core/harness.js`, `tests/browser/cdp.js`,
  `tests/library/remote_test_support.js`). Do not add a test framework.
- Mock only external dependencies (network, WebDAV, time). Examples already in the
  repo: the mock WebDAV server, and `pce_st_set_time` / `time` in automation for a
  fixed clock. Never mock the emulator core to test the core.
- Make sure the test **can fail**: break the code on purpose, or check the opposite
  case (see finding 20 in `NOTES.md`).
- Machine tests are deterministic: advance emulated time (frames, cycles), never
  `setTimeout`/real time. State is compared with `pce_st_state_hash()`.
- Browser tests: wait for the event or state you need with `waitFor`, don't read
  state right after an action; leave no data behind (`localStorage`, IndexedDB);
  open pages with `?crt=0` unless you test the CRT filter; keep timing thresholds
  loose. Known traps are in `implementation/WEB.md` ("Known traps when writing
  tests") and `NOTES.md` (findings 16, 20, 21).

## Hard rules

- **Never modify, delete, skip, or weaken an existing test to make it pass.**
  If you think a test is wrong, stop and explain why.
- Always run the tests before saying a task is done, and show the result.
- If existing tests are already failing before your change, tell me which ones.
  Don't fix or hide them unless asked.
- **Flaky tests:** if a test fails and you suspect timing, rerun that one test with
  `--only=`. If it passes, report it as flaky (name, the message and that it passed
  on rerun); do not call it fixed and do not change it.

## When I ask "improve the test strategy"

Start with a short report, without changing any code:

- How tests are currently organized (the five suites above) and what each covers.
- Which critical areas have no tests. For this project, check in particular:
  the core's exported functions (`implementation/CORE_API.md`), the guest-to-library
  save path, remote sync, snapshots, floppy formats (`.dim`, ACSI), and anything in
  `NOTES.md` under "Not verified".
- Failing, skipped, or flaky tests (run the suites to find out).
- A prioritized list of the 3-5 highest-value tests to add first.
