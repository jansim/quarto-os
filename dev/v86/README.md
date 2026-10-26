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

The script installs pinned `v86@0.5.472` and Playwright in ignored
`dev/v86/out/`, builds a Debian guest and copies only publication assets into
ignored `vm-assets/`. It uses the Debian base manifest pinned in `Dockerfile` and
signed APT repositories. The guest package versions follow bookworm; builds are
not yet bit-for-bit reproducible against a frozen Debian snapshot.

`Dockerfile` assembles i386 packages using an amd64 builder without executing
32-bit host programs. It keeps the modules required for virtio/9p and retains
package copyright notices. `init` mounts Linux pseudo-filesystems and the 9p
share, creates uid/gid 1000, initializes the user shell, and exposes a bootstrap
serial prompt. The browser copies the separately built agent through 9p and
starts it as `user`. Rebuild that agent with `ZIG="python -m ziglang" sh agent/build.sh`
after changing its C source (pinned Zig version: 0.14.1).

The script leaves the Docker image `quarto-os-v86-research` and build cache for
future runs, but removes its temporary stopped container. Supply a different
working directory as its first argument. For this cloud machine's injected proxy,
use `V86_DOCKER_NETWORK=host`; it reuses the proxy and adds its existing hostname
mapping without printing credentials or changing network policy.

The static publication directory contains:

- v86 JS/WASM and SeaBIOS firmware, pinned to runtime 0.5.472 and firmware 1.16.2;
- the Linux kernel and compressed initramfs;
- a manifest hashing the kernel and guest, used to invalidate incompatible caches;
- exact Debian source packages, including Built-Using/static components, plus
  v86/firmware sources, license texts, source inventory and build instructions.

The source archive is substantial (approximately 462 MiB in the tested build).
The guest is approximately 71 MiB compressed; cold boot measured about 25–30 s
with 1 GiB of guest memory. The Pages workflow builds and publishes these assets;
VM defaults use `https://jansim.github.io/quarto-os/vm-assets/`. Local docs configure
a project-relative `vm-assets/` path, resolved correctly for nested Quarto pages.
Other sites can self-host the same directory and configure `vm.asset-base`.

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
`--chromium /usr/bin/chromium`. It starts and stops its own server without COOP/COEP.

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
