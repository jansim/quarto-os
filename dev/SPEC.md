# Quarto OS — internal architecture spec

This is the contract between the pieces of the extension. Every module must
follow it so the pieces can be developed independently.

## Goal

A Quarto extension (`_extensions/quarto-os/`) that renders macOS-style windows
(title bar with traffic lights, rounded corners, soft shadows) in HTML docs,
websites and reveal.js slides. Windows hold arbitrary content (images, video,
code blocks, markdown) or "apps": a terminal, a VS Code-like editor and a
Finder-like file explorer, all backed by ONE shared headless Linux VM per page
(CheerpX, the engine behind WebVM — no WebVM UI, no graphical desktop in the
VM). Optional fake desktop (wallpaper, menubar, dock) that launches windows,
multiple instances of the same app allowed. Built for teaching (e.g. git in
the terminal + VS Code + explorer showing `.git`).

Bundle size matters: the core (`quarto-os.js` + `quarto-os.css`) must stay
small (target < 60 KB unminified total) and is the only thing loaded on every
page. Everything heavy is lazy-loaded the first time it's needed:
xterm (vendored), Monaco (CDN), CheerpX (Leaning Tech CDN), the VM layer.

## File layout / ownership

```
_extensions/quarto-os/
  _extension.yml          core
  quarto-os.lua           core   (filter + `os` shortcode)
  quarto-os.js            core   (classic script, defines window.QuartoOS)
  quarto-os.css           core
  coi-serviceworker.js    core   (cross-origin isolation for GitHub Pages)
  apps/terminal.js        apps   (ES module)
  apps/explorer.js        apps   (ES module)
  apps/vscode.js          apps   (ES module)
  apps/apps.css           apps   (lazy-loaded by the apps themselves)
  vendor/xterm/...        apps   (xterm.js + fit addon + css, vendored)
  vm/vm.js                vm     (ES module)
  vm/qos-agent            vm     (static i386 binary, built from agent/)
agent/                    vm     (C source + build script for qos-agent)
dev/                      test harnesses (prefix your files: vm-*, core-*, apps-*)
dev/server.mjs            shared static server WITH COOP/COEP headers + Range
                          support: `node dev/server.mjs <root> <port>`
_quarto.yml, index.qmd, examples/, .github/workflows/, README.md   docs
```

The repo root is itself a Quarto website project (so `_extensions/` is found);
it renders `index.qmd` and `examples/*.qmd` to `_site/` for GitHub Pages.

## Authoring syntax (handled by quarto-os.lua)

Enable with `filters: [quarto-os]` in the document/project YAML.

### Windows

````markdown
::: {.os-window title="cat.jpg" width="420px" height="300px"}
![](cat.jpg)
:::

::: {.os-window title="hello.py"}
```python
print("hi")
```
:::

::: {.os-window #t1 app="terminal" title="bash" height="320px" cwd="~/repo" run="git status"}
:::

{{< os terminal title="bash" height="300px" >}}
{{< os vscode folder="~/repo" open="README.md" >}}
{{< os explorer path="~" >}}
{{< os browser url="https://quarto.org" >}}
````

Window attributes (all optional):

| attr | meaning |
|---|---|
| `app` | `content` (default; wraps the div's markdown), `terminal`, `vscode`, `explorer`, `browser` |
| `title` | title bar text (default: app title) |
| `width`, `height` | CSS lengths; bare numbers mean px |
| `x`, `y` | position (px) when floating (inside a desktop, a slide, or `float=true`) |
| `float` | `true` → absolutely positioned & draggable over its container instead of in the flow |
| `id` | via `#id`; used by `.os-run target=` |
| `theme` | `light` / `dark` chrome for this window |
| `state` | `normal` / `minimized` / `maximized` (desktop only) |
| terminal | `cwd`, `run` (command typed after the shell starts; `;`-separated ok) |
| vscode | `folder` (workspace root), `open` (comma-separated files relative to folder) |
| explorer | `path` (start dir), `hidden` (`true` shows dotfiles; default true) |
| browser | `url` |

Paths may start with `~` (= VM home, `/home/user`).

### Desktop

````markdown
::: {.os-desktop #desk height="520px" dock="terminal,vscode,explorer" wallpaper="..."}
::: {.os-window app="terminal" x=40 y=40 width=520 height=300}
:::
:::
````

`height` default `480px`; `dock` default `terminal,vscode,explorer`;
`menubar` default `true`; `title` = app name shown in the menubar.
Nested `.os-window`s become floating windows inside the desktop.

### Launchers and run snippets

```markdown
[New terminal]{.os-launch app="terminal" target="desk" cwd="~/repo"}
`git status`{.os-run target="t1"}
```

- `.os-launch` → a button; each click opens a NEW window instance (any window
  attribute may be given). Target resolution when `target` is absent: inside a
  reveal.js slide → floating in that slide; else the only `.os-desktop` on the
  page if exactly one; else floating over the page (fixed overlay layer).
- `.os-run` (inline code or code block) → clickable; sends the text + Enter to
  terminal `target` (a window id), else the most recently focused terminal,
  else opens a new floating terminal and runs it there.

### Document options

```yaml
quarto-os:
  theme: light            # default chrome theme (light|dark)
  coi: true               # register coi-serviceworker.js on pages using the VM
  vm:
    disk: wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2
    disk-type: cloud      # cloud | github | bytes
    persist: false        # keep VM disk changes across reloads (IndexedDB)
    cache-id: quarto-os   # IndexedDB name for the overlay
    autoboot: false       # boot on page load instead of on first VM window
    setup: |              # bash script run once per (fresh) VM as `user` before apps attach
      mkdir -p ~/repo
```

## DOM contract (Lua output → JS)

- Window: `<div class="qos-window" id="…" data-qos-opts='{"app":"terminal","title":"bash",…}'>…children…</div>`
  (children only for `app=content`). All attributes from the markdown go into
  the JSON object (`x`,`y`,`width`,`height` kept as strings).
- Desktop: `<div class="qos-desktop" id="…" data-qos-opts='{…}'>…qos-window children…</div>`
- Launcher: `<button type="button" class="qos-launch" data-qos-opts='{…, "target":"desk"}'>label</button>`
- Run: `<code class="qos-run" data-qos-target="t1">git status</code>`; for code
  blocks the `<div class="sourceCode">`/`<pre>` gets class `qos-run` and the
  `data-qos-target` attribute.
- Config: `<script type="application/json" id="quarto-os-config">{…}</script>`
  in the head, with the `quarto-os:` YAML normalised to camelCase keys plus
  `"usesVM": true|false` (any VM app on the page incl. docks and launchers).
- Lua attaches `quarto-os.js` + `quarto-os.css` as an html dependency
  (`apps/`, `vm/`, `vendor/` shipped as dependency `resources`) and, if the page
  uses the VM and `coi` isn't false, `coi-serviceworker.js` via
  `quarto.doc.add_format_resource` (lands next to the rendered page).

## Core JS API (`window.QuartoOS`, defined by quarto-os.js)

```js
QuartoOS.config            // parsed config object
QuartoOS.baseUrl           // URL of the extension folder (from document.currentScript.src)
QuartoOS.open(app, opts)   // → Promise<Win>; opts as window attributes + {target, content}
QuartoOS.vm()              // → Promise<VM> (lazy import of vm/vm.js; singleton)
QuartoOS.run(text, target) // os-run behaviour
QuartoOS.loadScript(url)   // classic <script>, cached; hides window.define while loading (AMD clash with Monaco)
QuartoOS.loadCSS(url)      // cached <link rel=stylesheet>
QuartoOS.apps              // registry {name: {title, icon (svg string), module, vm, size:[w,h]}}
QuartoOS.windows           // live list of Win
QuartoOS.lastTerminal      // most recently focused terminal Win (or null)
```

`Win` (what an app receives):

```js
win.id, win.app, win.opts
win.el                     // outer .qos-window element
win.body                   // .qos-body element: the app renders into this; it fills the window below the title bar
win.setTitle(text)
win.focus(); win.close(); win.minimize(); win.maximize()
win.on(event, cb)          // 'resize' (size changed or became visible), 'focus', 'blur', 'close'
win.isVisible()
win.instance               // whatever the app's mount() resolved to
```

## App module contract (`apps/*.js`, ES modules)

```js
export async function mount(win, opts, os) {
  // render into win.body; may call os.vm(), os.open(), os.loadScript() …
  return {           // instance (all optional)
    focus() {}, dispose() {},
    run(text) {},    // terminal only: type text + "\r" once the shell is ready
  };
}
```

The core shows a lightweight placeholder while the module loads and calls
`instance.dispose()` when the window closes. Apps open other apps through
`os.open('vscode', {folder, open})` etc. The VS Code app's integrated terminal
reuses `apps/terminal.js` (export a helper such as `createTerminal(el, opts, os)`).

## VM API (`vm/vm.js`, ES module)

```js
export async function createVM(config /* QuartoOS.config.vm */, { baseUrl }) → vm
vm.ready                    // Promise resolved when the agent is up
vm.home                     // "/home/user"
vm.on('status', cb)         // boot progress strings, e.g. "Downloading CheerpX…"
vm.on('activity', cb)       // debounced after terminal output/exec, used to refresh views
vm.openSession({cols, rows, cwd, cmd, env}) → Promise<Session>   // pty running bash -l (or cmd)
  session.write(str | Uint8Array); session.resize(cols, rows)
  session.onData(cb /* Uint8Array */); session.onExit(cb /* code */); session.close()
vm.ls(path)       → Promise<[{name, type:'file'|'dir'|'link'|'other', size, mtime}]>  // no . / ..
vm.stat(path)     → Promise<{type, size, mtime} | null>
vm.readFile(path) → Promise<Uint8Array>;   vm.readText(path) → Promise<string>
vm.writeFile(path, data /* string|Uint8Array */) → Promise<void>
vm.exec(cmd, {cwd}) → Promise<{code, output}>   // sh -c as user, stdout+stderr merged
vm.mkdir(path); vm.remove(path /* recursive */); vm.rename(from, to)
vm.watch(dir, cb) → unsubscribe   // cb(entries) when the listing changes (polling, nudged by 'activity')
vm.reset()        // wipe the IndexedDB overlay and reload the page
```

`~` in any path argument expands to `vm.home`. Errors reject with `Error`
whose message is human readable.

## Facts established so far

- CheerpX 1.4.0: `import("https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js")`.
  Needs `crossOriginIsolated` (COOP same-origin + COEP require-corp/credentialless).
  Works in the sandbox's headless Chromium (Playwright at
  `/opt/node22/lib/node_modules/playwright/index.mjs`) when served by `dev/server.mjs`.
- Default disk `wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2`
  (Debian buster i386): bash, git 2.20.1, python3.7, nano, vim, `script`; no tmux.
  User `user` uid/gid 1000, home `/home/user`. First `cx.run` ≈ 10 s (disk streaming).
- CheerpX exposes ONE console: `send = cx.setCustomConsole((buf, vt) => …, cols, rows)`,
  `send(byteValue)` per input byte. So multiple terminals + file access go
  through an in-VM agent multiplexing ptys and fs ops over that console.
- `DataDevice.writeFile(path, data)` → visible read-only under its mount (e.g. `/data`).
- Zig (C cross-compiler) available: `<scratchpad>/zigenv/bin/python -m ziglang cc -target x86-linux-musl`.
