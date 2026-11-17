#!/bin/bash
# Builds PCE's Atari ST core (Leorivasc/pce fork) as a WASM library.
#
# Usage:  scripts/build-core.sh
# Optional variables:
#   PCE_SRC    PCE.js clone          (default ~/Documents/GIT/pce)
#   EMSDK_DIR  emsdk installation    (default ~/emsdk)
#   JOBS       make jobs             (default nproc)
#
# Output: build/out/pce_st_core.js (module, MODULARIZE) and pce_st_core.wasm.
# PCE's main(), its main loop and SDL are not used: core/st_glue.c is linked.
# It does not modify the PCE clone: it builds a clean copy (git archive).

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PCE_SRC=${PCE_SRC:-$HOME/Documents/GIT/pce}
EMSDK_DIR=${EMSDK_DIR:-$HOME/emsdk}
JOBS=${JOBS:-$(nproc)}
PCE_REV_EXPECTED=b2e4b44

BUILD_DIR=$PROJECT_DIR/build
SRC_DIR=$BUILD_DIR/pce-src
OUT_DIR=$BUILD_DIR/out

if ! command -v emcc >/dev/null 2>&1; then
  [[ -f $EMSDK_DIR/emsdk_env.sh ]] || { echo "ERROR: cannot find emcc or $EMSDK_DIR/emsdk_env.sh" >&2; exit 1; }
  # shellcheck disable=SC1091
  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
fi
echo "emcc: $(emcc --version | head -1)"

[[ -d $PCE_SRC/.git ]] || { echo "ERROR: $PCE_SRC is not a PCE clone" >&2; exit 1; }
rev=$(git -C "$PCE_SRC" rev-parse --short HEAD)
echo "PCE: $rev"
[[ $rev == "$PCE_REV_EXPECTED"* ]] || echo "WARNING: tested with $PCE_REV_EXPECTED, using $rev"

# Clean copy of the source, without artifacts from earlier builds.
rm -rf "$SRC_DIR" "$OUT_DIR"
mkdir -p "$SRC_DIR" "$OUT_DIR" "$BUILD_DIR/bin"
git -C "$PCE_SRC" archive HEAD | tar -x -C "$SRC_DIR"

# PCE's scripts call "python".
ln -sf "$(command -v python3)" "$BUILD_DIR/bin/python"
export PATH=$BUILD_DIR/bin:$PATH

# -DEMSCRIPTEN: modern Emscripten only defines __EMSCRIPTEN__ and PCE uses
#   "#ifdef EMSCRIPTEN" in sysdep.c (no sleeping, no real-time synchronization).
CFLAGS="-O2 -DEMSCRIPTEN -Qunused-arguments -include src/include/pcedeps.h"

cd "$SRC_DIR"
emconfigure ./configure CFLAGS="$CFLAGS" EMSCRIPTEN=yes --prefix="$BUILD_DIR/install" \
  --disable-macplus --disable-ibmpc --disable-cpm80 --disable-rc759 \
  --disable-sim405 --disable-sims32 --disable-simarm --disable-spectrum --disable-vic20 \
  --disable-char-termios --disable-char-tcp --disable-char-pty --disable-char-ppp --disable-char-slip \
  --disable-tun --disable-sound-oss --disable-readline --without-x --without-sdl \
  > "$BUILD_DIR/configure.log" 2>&1 || { tail -20 "$BUILD_DIR/configure.log"; exit 1; }

# Compile all the objects (linking PCE's own executable is not used).
make -j"$JOBS" CFLAGS="$CFLAGS" > "$BUILD_DIR/make.log" 2>&1 \
  || { grep -E "error" "$BUILD_DIR/make.log" | cut -c1-200 | head -20; echo "ERROR: make failed (see $BUILD_DIR/make.log)" >&2; exit 1; }

# The ST's objects according to PCE's own Makefile, without main.o (the glue replaces it).
OBJS=$(make -s --eval 'print-objs: ; @echo $(PCE_ATARIST_OBJ) $(PCE_ATARIST_OBJ_EXT)' print-objs \
  | tr ' ' '\n' | grep -v '/atarist/main\.o$' | tr '\n' ' ')

emcc $CFLAGS -I src -I . -c "$PROJECT_DIR/core/st_glue.c" -o "$BUILD_DIR/st_glue.o"

EXPORTS=$(grep -o 'pce_st_[a-z0-9_]*' "$PROJECT_DIR/core/st_glue.c" | sort -u \
  | grep -v '^pce_st_$' | sed 's/^/_/' | paste -sd, -)
EXPORTS="$EXPORTS,_malloc,_free"

# shellcheck disable=SC2086
emcc $CFLAGS $OBJS "$BUILD_DIR/st_glue.o" -lm -o "$OUT_DIR/pce_st_core.js" \
  --no-entry -Wl,--wrap=time -Wl,--wrap=localtime -Wl,--wrap=wd179x_set_cmd \
  -sMODULARIZE=1 -sEXPORT_NAME=PCE_STCoreFactory \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
  > "$BUILD_DIR/link.log" 2>&1 || { cat "$BUILD_DIR/link.log" | cut -c1-250 | head -20; echo "ERROR: link failed" >&2; exit 1; }

echo "OK -> $OUT_DIR"
ls -la "$OUT_DIR"
