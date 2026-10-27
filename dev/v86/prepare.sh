#!/usr/bin/env bash
# Build the guest, clean boot snapshot and static publication assets.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/out"}
mkdir -p "$out"
out=$(cd "$out" && pwd)
profile=${V86_GUEST_PROFILE:-slim}
case "$profile" in slim|full) ;; *) echo "Unknown V86_GUEST_PROFILE: $profile" >&2; exit 1 ;; esac

bash "$here/install-tools.sh" "$out"
revision=cc37f35c43bf14865d74ad76879ecf9410f69eb1
for file in seabios.bin vgabios.bin COPYING.LESSER fetch-and-build-seabios.sh; do
  curl -fsSL "https://raw.githubusercontent.com/copy/v86/$revision/bios/$file" -o "$out/$file"
done

build_args=(build --pull --platform linux/amd64 --build-arg "GUEST_PROFILE=$profile")
if [ -n "${V86_DOCKER_NETWORK:-}" ]; then
  build_args+=(--network "$V86_DOCKER_NETWORK")
fi
# Docker build containers do not inherit /etc/hosts entries for injected proxies.
# Reuse the configured proxy and its DNS result, without exposing credentials.
if [ -n "${http_proxy:-}" ]; then
  proxy_mapping=$(node --input-type=module <<'JS'
import {lookup} from 'node:dns/promises';
const hostname = new URL(process.env.http_proxy).hostname;
const {address} = await lookup(hostname, {family:4});
console.log(hostname + ':' + address);
JS
  )
  build_args+=(--add-host "$proxy_mapping")
fi
export BUILDX_CONFIG=${BUILDX_CONFIG:-"$out/buildx"}
image=quarto-os-v86-research
docker "${build_args[@]}" -t "$image" "$here"
guest_container=$(docker create "$image")
trap 'docker rm "$guest_container" >/dev/null' EXIT
docker cp "$guest_container:/bzimage" "$out/bzimage"
docker cp "$guest_container:/guest.cpio.gz" "$out/initrd.gz"
docker cp "$guest_container:/fs.json" "$out/fs.json"
mkdir -p "$out/rootfs"
docker cp "$guest_container:/rootfs/." "$out/rootfs/"
docker cp "$guest_container:/guest-sources.tar.gz" "$out/guest-sources.tar.gz"
docker cp "$guest_container:/source-packages.txt" "$out/source-packages.txt"
sha256sum "$out/bzimage" "$out/initrd.gz" "$out/seabios.bin" "$out/vgabios.bin"
# Copy only redistributable runtime assets into the static-site resource tree.
site_assets="$here/../../vm-assets"
mkdir -p "$site_assets"
for file in bzimage initrd.gz fs.json seabios.bin vgabios.bin COPYING.LESSER fetch-and-build-seabios.sh guest-sources.tar.gz source-packages.txt; do
  cp "$out/$file" "$site_assets/$file"
done
mkdir -p "$site_assets/rootfs"
cp -a "$out/rootfs/." "$site_assets/rootfs/"
cp "$out/node_modules/v86/build/libv86.js" "$site_assets/libv86.js"
cp "$out/node_modules/v86/build/v86.wasm" "$site_assets/v86.wasm"
cp "$out/node_modules/v86/build/v86-fallback.wasm" "$site_assets/v86-fallback.wasm"
cp "$out/node_modules/v86/LICENSE" "$site_assets/LICENSE.v86"
node --input-type=module - "$site_assets" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir = process.argv[2];
const image = createHash('sha256').update(fs.readFileSync(path.join(dir,'bzimage'))).update(fs.readFileSync(path.join(dir,'initrd.gz'))).update(fs.readFileSync(path.join(dir,'fs.json'))).digest('hex');
fs.writeFileSync(path.join(dir,'manifest.json'), JSON.stringify({runtime:'0.5.472', image, filesystem:{metadata:'fs.json',base:'rootfs/'}}, null, 2)+'\n');
JS

curl -fsSL "https://codeload.github.com/copy/v86/tar.gz/$revision" -o "$site_assets/v86-source.tar.gz"
curl -fsSL https://codeload.github.com/coreboot/seabios/tar.gz/refs/tags/rel-1.16.2 -o "$site_assets/seabios-source.tar.gz"
curl -fsSL https://raw.githubusercontent.com/coreboot/seabios/rel-1.16.2/COPYING -o "$site_assets/COPYING"
cp "$here/Dockerfile" "$here/init" "$here/collect-sources.sh" "$here/slim-guest.sh" "$here/boot-init" "$here/pack-guest.sh" "$here/build-boot-state.mjs" "$site_assets/"
mkdir -p "$site_assets/tools"
cp "$here/tools/"* "$site_assets/tools/"
cat > "$site_assets/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Quarto OS VM sources and licenses</title>
<h1>Quarto OS VM sources and licenses</h1>
<p>The emulator is v86 (BSD-2-Clause), with separately licensed dependencies.
SeaBIOS is LGPL-3.0. The Linux guest contains software under its individual licenses;
package copyright notices are retained in the guest under /usr/share/doc.</p>
<ul>
<li><a href="LICENSE.v86">v86 license</a>; <a href="v86-source.tar.gz">complete pinned v86 sources and dependency notices</a></li>
<li><a href="COPYING.LESSER">LGPL-3.0</a> and <a href="COPYING">GPL-3.0</a>;
<a href="seabios-source.tar.gz">SeaBIOS 1.16.2 sources</a> and <a href="fetch-and-build-seabios.sh">firmware build instructions</a></li>
<li><a href="guest-sources.tar.gz">Exact Debian guest source packages, including Linux and statically linked components</a>;
<a href="source-packages.txt">source version inventory</a></li>
<li>Guest build: <a href="Dockerfile">Dockerfile</a>, <a href="init">init</a>, <a href="slim-guest.sh">slimming script</a>, <a href="collect-sources.sh">source collection script</a>, <a href="boot-init">boot init</a>,
<a href="pack-guest.sh">filesystem packing</a>, <a href="build-boot-state.mjs">snapshot builder</a>;
<a href="tools/README.md">pinned upstream filesystem tools</a> and <a href="tools/LICENSE">their license</a></li>
</ul>
<p>The Quarto OS agent source and build script are in the <a href="https://github.com/jansim/quarto-os/tree/main/agent">project repository</a>.</p>
HTML

snapshot_memory=512
if [ "$profile" = full ]; then snapshot_memory=1024; fi
node "$here/build-boot-state.mjs" "$site_assets" "$out/node_modules/v86/build/libv86.mjs" "$snapshot_memory"
cp "$site_assets/manifest.json" "$out/manifest.json"
