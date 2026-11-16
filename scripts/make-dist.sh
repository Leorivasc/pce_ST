#!/bin/bash
# Assembles the static files the page needs into dist/, ready to copy to a web server.
#
# Usage:  scripts/make-dist.sh            (requires scripts/build-core.sh to have been run)
# Result: dist/ with the same relative layout the page expects:
#           web/                      the page (index.html, js, css, fonts, icons)
#           build/out/                pce_st_core.js and pce_st_core.wasm
#           core/st_config.js         machine configuration builder
#           roms/emutos/              EmuTOS 192K (GPL, see its license.txt)
#           index.html                redirect to web/index.html
#           .htaccess                 Apache settings (types, compression, caching)

set -euo pipefail
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"
for f in build/out/pce_st_core.js build/out/pce_st_core.wasm; do
  [[ -f $f ]] || { echo "ERROR: $f is missing: run scripts/build-core.sh first" >&2; exit 1; }
done

rm -rf dist
mkdir -p dist/build/out dist/core dist/roms/emutos
cp -r web dist/web
cp build/out/pce_st_core.js build/out/pce_st_core.wasm dist/build/out/
cp core/st_config.js dist/core/
cp roms/emutos/etos192us.img roms/emutos/license.txt roms/emutos/authors.txt roms/emutos/README.md dist/roms/emutos/
cp COPYING NOTICE.md dist/
cat > dist/index.html <<'HTML'
<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=web/index.html">
<title>PCE_ST</title>
<a href="web/index.html">PCE_ST</a>
HTML
cp scripts/dist.htaccess dist/.htaccess
echo "dist/ ready ($(du -sh dist | cut -f1)). Copy its contents to the web server's folder."
