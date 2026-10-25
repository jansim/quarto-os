#!/bin/sh
# Copy the core extension files into a throwaway test copy (with stub apps/vm).
set -e
D=$(cd "$(dirname "$0")" && pwd)
SRC="$D/../../_extensions/quarto-os"
DST="$D/_extensions/quarto-os"
mkdir -p "$DST/apps" "$DST/vm" "$DST/vendor/stub"
for f in _extension.yml quarto-os.lua quarto-os.js quarto-os.css coi-serviceworker.js; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DST/$f"
done
cp "$D/stubs/"*.js "$DST/apps/"
cp "$D/stubs/vm.js" "$DST/vm/vm.js"
echo "/* vendor placeholder */" > "$DST/vendor/stub/placeholder.js"
rm -f "$DST/apps/vm.js"
# refresh already-rendered copies (so we don't have to re-render for JS/CSS changes)
for d in "$D"/*_files/libs/quarto-contrib/quarto-os-*; do
  [ -d "$d" ] || continue
  cp "$SRC/quarto-os.js" "$SRC/quarto-os.css" "$d/"
done
# (coi-serviceworker.js is copied by quarto render via the html dependency)
# `./sync.sh integ`: copy the REAL extension (real apps/vm/vendor) into integ/ for integration tests
if [ "$1" = "integ" ]; then
  rm -rf "$D/integ/_extensions" && mkdir -p "$D/integ/_extensions" && cp -r "$SRC" "$D/integ/_extensions/"
fi
exit 0
