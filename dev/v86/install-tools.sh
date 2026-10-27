#!/usr/bin/env bash
# Install the same pinned tools for a guest build or a CI asset-cache hit.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/out"}
mkdir -p "$out"
cp "$here/package.json" "$here/package-lock.json" "$out/"
npm ci --prefix "$out" --no-audit --no-fund
