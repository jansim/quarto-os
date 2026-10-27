# Quarto OS

A [Quarto](https://quarto.org) extension that renders **macOS-style windows**, a **fake
desktop** and a **real Linux VM** — terminal, VS Code-like editor, Finder-like file
explorer — inside HTML documents, websites and reveal.js slides. Built for teaching:
show `git` in a terminal next to an explorer that displays `.git` and an editor with
source control, all running in the reader's browser.

**Examples & docs: <https://jansim.github.io/quarto-os/>**

![Quarto OS: windows, a terminal, VS Code and an explorer on one page](examples/assets/screenshot.png)

- **Content windows** around any Markdown: images, video, code, callouts — inline,
  side by side, or floating and draggable; light and dark chrome.
- **Apps on a real VM**: `terminal`, `vscode`, `explorer` (and `browser`), all backed by
  one Debian VM per page, powered by [v86](https://github.com/copy/v86) (BSD-2-Clause). No server needed.
- **Desktop** with wallpaper, menubar and dock; multiple instances of each app.
- **Launch buttons** and clickable **run snippets** that type commands into a terminal.
- **Lazy**: pages only load a small core; xterm.js, Monaco and v86 are loaded when
  a window needs them.

## Install

```bash
quarto add jansim/quarto-os
```

Then enable the filter in a document's front matter or in `_quarto.yml`:

```yaml
filters:
  - quarto-os
```

## Usage

````markdown
::: {.os-window title="hello.py"}
```python
print("Hello from a window!")
```
:::

::: {#shell .os-window app="terminal" height="300px" cwd="~"}
:::

Click to run: `python3 --version`{.os-run target="shell"}

{{< os vscode folder="~/repo" open="README.md" >}}
{{< os explorer path="~" >}}

::: {#desk .os-desktop height="520px" dock="terminal,vscode,explorer"}
::: {.os-window app="terminal" x=40 y=40 width=520 height=300}
:::
:::

[New terminal]{.os-launch app="terminal" target="desk" cwd="~/repo"}
````

### Window attributes

| Attribute | Meaning |
|---|---|
| `app` | `content` (default), `terminal`, `vscode`, `explorer`, `browser` |
| `title` | Title bar text |
| `width`, `height` | CSS lengths; bare numbers are px |
| `x`, `y` | Position (px) when floating (desktop, slide, or `float=true`) |
| `float` | `true` → absolutely positioned and draggable over its container |
| `#id` | Target for `.os-run` snippets and launchers |
| `theme` | `light` / `dark` chrome |
| `state` | `normal` / `minimized` / `maximized` (desktop only) |
| terminal | `cwd`, `run` (command typed once the shell is ready; `;`-separated ok) |
| vscode | `folder` (workspace root), `open` (comma-separated files) |
| explorer | `path` (start directory), `hidden` (show dotfiles, default `true`) |
| browser | `url` |

Desktops (`.os-desktop`) take `height` (default `480px`), `dock` (default
`terminal,vscode,explorer`), `menubar` (default `true`), `title` and `wallpaper`.

### Document options

```yaml
quarto-os:
  theme: light            # default chrome theme (light|dark)
  vm:
    asset-base: https://jansim.github.io/quarto-os/vm-assets/
    memory: 512           # guest RAM in MiB
    boot-snapshot: true  # restore the prebuilt clean boot state
    boot-timeout: 120000  # milliseconds
    persist: false        # keep VM disk changes across reloads (IndexedDB)
    cache-id: quarto-os   # IndexedDB name for the overlay
    autoboot: false       # boot on page load instead of on first VM window
    setup: |              # bash script run once per fresh VM before apps attach
      mkdir -p ~/repo
```

The full reference is on the [docs site](https://jansim.github.io/quarto-os/#reference).

## How it works

- `quarto-os.lua` turns the Markdown syntax into plain HTML with JSON options and
  attaches the small core (`quarto-os.js` + `quarto-os.css`).
- The core draws windows and desktops and lazy-loads app modules (`apps/*.js`) when a
  window needs them.
- The apps share **one VM per page** (`vm/vm.js`). v86 boots Debian i386 in
  WebAssembly. The small C agent (`agent/qos-agent.c`) serves file operations,
  executes commands as uid 1000, and multiplexes six independent Linux PTYs over
  one serial channel. A prebuilt boot snapshot skips kernel startup, and root
  files load on demand from the static asset host. Each terminal has its own size and job control.
- The VM works on ordinary static hosts, including GitHub Pages. It needs no
  cross-origin isolation headers or first-visit service-worker reload.
- Changes are temporary by default. `persist: true` saves compressed machine
  snapshots atomically in IndexedDB; `await vm.save()` explicitly checkpoints
  before navigating away. A restored page closes stale terminal processes and
  reruns setup only if its script changed. Old CheerpX overlays are not imported.

Limitations: six terminals per page, no guest network, 512 MiB of guest
RAM, plus temporary snapshot memory. Uncached root files require access to the
static asset host after boot. Chromium and Firefox are recommended.
Snapshots are versioned against the runtime, guest image and agent; rebuilding any
of them starts a fresh cache. See the [docs](https://jansim.github.io/quarto-os/#limitations).

## Development

```
_extensions/quarto-os/   the extension (Lua filter, core JS/CSS, apps/, vm/, vendor/)
agent/                   C source of the in-VM agent + build script
examples/                example pages (rendered to GitHub Pages)
index.qmd, _quarto.yml   docs site
dev/                     test harnesses and a static dev server
```

- **Build the agent** (static i386 binary, cross-compiled with [zig](https://ziglang.org)):
  `agent/build.sh` writes `_extensions/quarto-os/vm/qos-agent` (commit the result). It
  uses `zig` from `PATH`; with the PyPI package use `ZIG="python -m ziglang" agent/build.sh`.
- **Render the docs site**: `quarto render` (outputs to `_site/`).
- **Build the open VM assets** (Docker + Node + curl): `bash dev/v86/prepare.sh`.
  The default slim Debian guest is about 47 MiB compressed (55 MiB including the
  kernel and emulator). `V86_GUEST_PROFILE=full bash dev/v86/prepare.sh` retains
  optional Perl/Git helpers; configure `vm.memory: 1024` for that larger guest.
  This writes ignored `vm-assets/` with the runtime, guest and corresponding sources.
  See [the build guide](dev/v86/README.md) for proxy support and tests.
- **Serve it locally**: `node dev/server.mjs _site 8000 nocoi`.

- **Regenerate the demo assets** (image + looping video, needs ffmpeg + Playwright):
  `node dev/docs-assets.mjs`; the README screenshot comes from
  `node dev/docs-screenshot.mjs` (with the dev server running on port 8204).

### Publishing the examples

`.github/workflows/publish.yml` renders the site and deploys `_site/` to GitHub Pages
on every push to `main` (or manually via *Run workflow*). In the repository settings,
set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.

## Licensing

- [v86](https://github.com/copy/v86) is BSD-2-Clause licensed, with separately
  licensed dependencies. Commercial use does not require a proprietary VM license.
- SeaBIOS firmware is LGPL-3.0. The Debian guest retains each package's license,
  including Linux, Git, Bash and BusyBox copyleft licenses. The build publishes
  matching source packages, firmware sources, notices and build instructions at
  [VM sources and licenses](https://jansim.github.io/quarto-os/vm-assets/).
- xterm.js, Monaco Editor and the Noble Hashes SHA-256 fallback are MIT licensed. The demo images and video were
  generated for this project.
