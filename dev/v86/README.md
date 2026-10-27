# v86 Linux backend

Quarto OS uses [v86](https://github.com/copy/v86), a BSD-2-Clause x86 emulator,
with a Debian i386 guest. The original investigation for
[issue #2](https://github.com/jansim/quarto-os/issues/2) also considered TinyEMU
(MIT), jor1k (Simplified BSD), and container2wasm (Apache-2.0 converter with
separately licensed emulators). v86 retains the agent's x86 architecture and
provides serial I/O, real Linux PTYs, virtio 9p sharing and complete snapshots.
It works on static hosts without cross-origin isolation or a disk WebSocket.

## Build

Requirements: Docker, Node, npm, curl. From the repository root:

```sh
bash dev/v86/prepare.sh
```

The script uses `install-tools.sh` and the committed npm lockfile to install
pinned `v86@0.5.472` and Playwright in ignored
`dev/v86/out/`, builds a Debian guest and copies only publication assets into
ignored `vm-assets/`. It uses the Debian base manifest pinned in `Dockerfile` and
signed APT repositories. Source collection is cached in a separate build stage,
so changing profiles or the trimming script does not re-download the sources. The guest package versions follow bookworm; builds are
not yet bit-for-bit reproducible against a frozen Debian snapshot.

`Dockerfile` assembles i386 packages using an amd64 builder without executing
32-bit host programs. It keeps the modules required for virtio/9p and retains
package copyright notices. `boot-init` mounts the on-demand 9p root; `init` mounts
Linux pseudo-filesystems, creates uid/gid 1000, initializes the user shell, and
exposes a bootstrap serial prompt. The browser copies the separately built agent through 9p and
starts it as `user`. Rebuild that agent with `ZIG="python -m ziglang" sh agent/build.sh`
after changing its C source (pinned Zig version: 0.14.1).

The script leaves the Docker image `quarto-os-v86-research` and build cache for
future runs, but removes its temporary stopped container. Supply a different
working directory as its first argument. Docker uses its configured build proxy.
The script adds the configured proxy hostname
mapping when needed, without printing credentials. `V86_DOCKER_NETWORK` is an
optional Docker network override for environments that require one.

The static publication directory contains:

- v86 JS/WASM and SeaBIOS firmware, pinned to runtime 0.5.472 and firmware 1.16.2;
- the Linux kernel, a tiny boot initramfs, `fs.json` metadata and Zstandard-compressed
  content-addressed `rootfs/` files;
- a gzip-compressed clean boot snapshot, captured before agent or lesson setup;
- a manifest hashing the kernel and guest, used to invalidate incompatible caches;
- exact Debian source packages, including Built-Using/static components, plus
  v86/firmware sources, license texts, source inventory and build instructions.

The source archive is substantial (approximately 462 MiB in the tested build).
The default slim guest uses 512 MiB of guest memory. Previously its entire
47.1 MiB compressed initramfs (116 MiB expanded) downloaded before Linux booted,
with approximately 55 MiB of startup assets including the kernel and emulator.
The new layout loads root files on demand; the roughly 21.5 MiB clean snapshot
also skips kernel boot. See the startup measurement command below. The Pages workflow
builds and publishes these assets;
VM defaults use `https://jansim.github.io/quarto-os/vm-assets/`. Local docs configure
a project-relative `vm-assets/` path, resolved correctly for nested Quarto pages.
Other sites can self-host the same directory and configure `vm.asset-base`.

## Guest profiles

The default `slim` profile keeps Bash, Python, core Git, shared libraries,
terminfo, C.UTF-8 support and package copyright notices. A short, commented
`slim-guest.sh` removes Perl and its SDK, udev hardware databases, initramfs-building
utilities, Git network/mail helpers and Scalar. The custom init already mounts
Linux pseudo-filesystems and loads the necessary drivers directly. The build
fails if the compressed slim guest exceeds 50 MiB, guarding against size regressions.

Supported Git workflows include local init, status, add, commit, diff, log,
branches, stash, local clone, fsck and archive. Optional Perl-based tools such as
`git filter-branch` require the full profile:

```sh
V86_GUEST_PROFILE=full bash dev/v86/prepare.sh
```

Use `vm.memory: 1024` with that guest; an explicit value is needed because the
runtime defaults to 512 MiB for the slim image. The full profile bypasses the
trimming script and slim size budget. Both profiles publish the same complete
source inventory, including notices for the original signed packages. These
source archives are downloaded only on request, never during VM startup.

## Startup and on-demand files

The build generates v86 filesystem metadata and individually compressed backing
files using the pinned upstream tools in `tools/`. A tiny initramfs mounts this
9p root. `/mnt/host` points to writable `/data`; user files and mutable root files
are included in persisted machine snapshots.

`build-boot-state.mjs` boots the same guest in Node, stops at the root bootstrap
prompt after outstanding filesystem reads finish, and saves a clean state. It
contains no agent, lesson setup or user data. Its content-addressed filename and
SHA-256 checksum appear in the manifest. At startup, a compatible persisted user
snapshot takes precedence; otherwise the browser verifies and restores the clean
snapshot. Missing or corrupt clean snapshots fail startup with an error. A
different `vm.memory` also reports an error; use matching memory or explicitly
disable the public snapshot for kernel boot. The guest clock is synchronized
before starting the agent and lesson setup.

Set `vm.boot-snapshot: false` to bypass the public snapshot while keeping
on-demand loading. This trades slower kernel boot for a smaller download on fast
CPUs or slow connections. It does not disable persisted user snapshots.
Decompressing/restoring any snapshot needs additional temporary browser memory;
guest RAM is still 512 MiB, and browser process memory can be higher.

Uncached root files require a connection to the static asset host, even after
boot. This is separate from guest networking, which remains unavailable. Keep
old content-addressed backing files available while older pages or persisted
snapshots are in use; versioned asset directories are recommended for custom
hosting. Browser HTTP caching may help repeat visits but does not guarantee an
offline VM.

Run `node dev/v86/startup.mjs --port 8203` for fresh-context startup measurements
and missing/corrupt/memory-mismatched snapshot error checks. It reports local-machine readiness
time and decoded VM asset response bytes; it does not model Internet latency or
HTTP compression. Python fault-in and guest clock correctness are checked after
readiness. See the PR for measurements against the previous initramfs build.

Debian and one visible trimming script remain the simplest maintenance path.
v86 also provides an upstream [Alpine guest recipe](https://github.com/copy/v86/tree/master/tools/docker/alpine);
Alpine or Buildroot could reduce the base further, at the cost of switching the
guest package ecosystem and validating a different kernel and libc.

Rebuilding the guest changes its manifest hash and invalidates existing machine
snapshots. Export important guest files before deploying the new image.

## Tests

Install a browser once if the machine does not provide one:

```sh
dev/v86/out/node_modules/.bin/playwright install --with-deps chromium
```

Start the repository server without isolation headers and run the existing suites:

```sh
node dev/server.mjs . 8203 nocoi
# In another terminal:
node dev/vm-test.mjs --port 8203 --suite all
node dev/apps-e2e.mjs --port 8203 --real
node dev/v86/lifecycle.mjs --port 8203
node dev/v86/startup.mjs --port 8203
node --test dev/v86/hash.test.mjs
node dev/v86/http-origin.mjs --port 8203
```

Before the app suite, prepare the ignored Quarto fixtures:

```sh
sh dev/core-tests/sync.sh
quarto render dev/core-tests/slides.qmd
quarto render dev/core-tests/doc.qmd
node dev/apps-mkslides.mjs
```

The final generator refreshes tracked generated HTML fixtures; inspect its diff.
Use Quarto 1.10.19, matching CI. `PLAYWRIGHT_MODULE` can point to an alternate
Playwright `index.mjs`; `CHROMIUM_PATH` selects a system browser. HTTPS tests need
the platform's certificate store available; never disable certificate validation.

`smoke.mjs` separately checks the guest's shell, 9p exchange, PTY, Git and snapshot
primitives. Run it with `--assets dev/v86/out` and
`--playwright "$PWD/dev/v86/out/node_modules/playwright/index.mjs"`; optionally pass
`--chromium /usr/bin/chromium`. Use `--memory 1024 --full-profile` to also
verify the full profile's Perl-based Git helpers. It starts and stops its own server without COOP/COEP.

## Persistence and protocol

The public VM API is unchanged; `vm.save()` adds an explicit durability boundary.
With `persist: true`, idle activity checkpoints the machine into a gzip Blob in
IndexedDB. The store commits atomically, so a failed write retains the last saved
snapshot. Restores include mutable 9p data; the agent discards stale terminal/exec
processes before the new page applies defaults and setup. Image, runtime, memory
and agent changes invalidate snapshots. Old CheerpX overlays are not imported.

Page-exit saves are best effort. Await `vm.save()` before navigating away when the
latest changes must be retained. Storage/quota failures are reported in the status
channel. `vm.reset()` waits for a pending save, clears this backend's cache and
reloads from the pristine guest.

See [the agent protocol](../../agent/README.md). Six shells use distinct Linux PTYs;
input credits bound UART traffic, PTY writes are nonblocking, and Linux handles
per-terminal resize, job control and interrupt characters.

## Migration from 0.1

The old `disk`, `disk-type` and `cheerpx` settings are rejected with a migration
error; provide a built v86 asset directory with `asset-base` instead. The old
`coi` setting is no longer needed. Old IndexedDB overlays are left intact but
are not imported; v86 uses a separate database suffix (`:v86`).

## Ordinary HTTP hosting

Web Crypto's `crypto.subtle` is unavailable on HTTP origins other than trustworthy
localhost origins. Agent cache identities use Web Crypto when available and a
lazy-loaded, vendored Noble Hashes 2.0.1 implementation otherwise. Both compute
identical SHA-256 values. No COOP/COEP headers or service-worker reload are needed.

`http-origin.mjs` serves local assets under a virtual `.test` HTTP origin and asserts that
`isSecureContext` is false and `crypto.subtle` is absent, and tests real boot,
Python execution, persistence across reloads, and terminal error text. The hash
unit tests compare both paths against standard vectors and Node's SHA-256.

## CI caching

The Pages workflow caches the complete `vm-assets/` directory, including the
matching guest sources, filesystem metadata and clean boot snapshot. An exact
cache hit skips Docker and snapshot generation; browser tests and site rendering
still run, and the Linux agent is rebuilt from the current source every time.
The cache key includes guest/build scripts, Docker inputs, the pinned tool
lockfile, runtime filesystem tools, runner OS/architecture and the UTC ISO week.
There are no partial asset restores. The first build in a new week rebuilds the
guest from the rolling Debian repositories. For an earlier refresh, delete the
matching `vm-assets-v1-...` cache under the repository's Actions caches.

npm and pip downloads are cached by their committed dependency files. The
Playwright browser cache is keyed by the npm lockfile and runner OS/architecture;
`playwright install --with-deps chromium` still runs to ensure OS libraries are
present. Node modules, Python environments and rendered site output are not
cached. On an asset-cache hit, `install-tools.sh` installs only the pinned npm
packages needed by the browser tests, without Docker or source downloads.

GitHub's cache scope rules apply: PRs can read eligible default-branch caches,
while their saved caches remain scoped to their PR merge ref. A cold cache still
runs the complete build. The asset cache is roughly 540 MiB (mostly corresponding
sources); GitHub may evict it under its cache quota. Actual warm-run savings need
to be measured in Actions. Tests and rendering remain part of every warm run.

PR checks have their own concurrency group and superseded PR runs are cancelled.
Push/manual publishing runs remain serialized and are not cancelled in progress.
