#!/bin/sh
# Builds qos-agent as a static 32-bit x86 Linux binary (CheerpX runs i386 only).
#
#   agent/build.sh                 # uses `zig` from PATH
#   ZIG="python -m ziglang" agent/build.sh
#
# Output: _extensions/quarto-os/vm/qos-agent (committed, ~40 KB).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../_extensions/quarto-os/vm/qos-agent"
ZIG=${ZIG:-zig}
mkdir -p "$(dirname "$out")"
# shellcheck disable=SC2086  # $ZIG may be a multi-word command
$ZIG cc -target x86-linux-musl -Os -s -static \
  -Wall -Wextra -Wno-unused-result -Wno-missing-field-initializers \
  -ffunction-sections -fdata-sections -Wl,--gc-sections \
  -o "$out" "$here/qos-agent.c"
ls -l "$out"
