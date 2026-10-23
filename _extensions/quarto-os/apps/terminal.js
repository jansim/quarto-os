// Quarto OS — Terminal app (xterm.js 6 + a pty session in the shared Linux VM).
// Exports mount() (app contract) and createTerminal() (reused by the VS Code panel).

import { h, loadAppCSS, loadCSS, mountRoot, listen, errMsg, onResize, isMac, copyText } from './common.js';

const VENDOR = new URL('../vendor/xterm/', import.meta.url).href;
const FONT = '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", monospace';

const THEMES = {
  dark: {
    background: '#1e1e1e', foreground: '#e2e2e2', cursor: '#e8e8e8', cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(120,160,255,0.35)',
    scrollbarSliderBackground: 'rgba(255,255,255,0.14)', scrollbarSliderHoverBackground: 'rgba(255,255,255,0.24)', scrollbarSliderActiveBackground: 'rgba(255,255,255,0.32)',
    black: '#1e1e1e', red: '#f0605b', green: '#4fc76a', yellow: '#e5c15f', blue: '#4f9cf5', magenta: '#d27bd9', cyan: '#4cc5d6', white: '#d4d4d4',
    brightBlack: '#7c7c7c', brightRed: '#ff7b74', brightGreen: '#6fe08a', brightYellow: '#f5d77d', brightBlue: '#75b3ff', brightMagenta: '#e597ea', brightCyan: '#74dbe8', brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0,100,255,0.22)',
    scrollbarSliderBackground: 'rgba(0,0,0,0.16)', scrollbarSliderHoverBackground: 'rgba(0,0,0,0.26)', scrollbarSliderActiveBackground: 'rgba(0,0,0,0.34)',
    black: '#000000', red: '#c41a16', green: '#1d8b2c', yellow: '#946f00', blue: '#0b5fd6', magenta: '#a535ae', cyan: '#0e7f93', white: '#bfbfbf',
    brightBlack: '#6e6e6e', brightRed: '#e0322d', brightGreen: '#26a33a', brightYellow: '#b08700', brightBlue: '#2d7bf0', brightMagenta: '#c04fca', brightCyan: '#1597ad', brightWhite: '#9a9a9a',
  },
};

let xtermP = null;
function loadXterm(os) {
  if (!xtermP) {
    xtermP = Promise.all([
      import(VENDOR + 'xterm.mjs'),
      import(VENDOR + 'addon-fit.mjs'),
      import(VENDOR + 'addon-web-links.mjs').catch(() => null),
      loadCSS(os, VENDOR + 'xterm.css'),
    ]).then(([x, f, w]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon, WebLinksAddon: w && w.WebLinksAddon }))
      .catch(e => { xtermP = null; throw e; });
  }
  return xtermP;
}

const PLACEHOLDER = 'Starting…';
const stripAnsi = t => t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][\w]|\x1b./g, '').replace(/\r/g, '');
// bash shows "user@:" when the VM has no hostname; keep titles tidy.
const tidyTitle = t => t.replace(/^([^@\s]+)@:\s*/, '$1@quarto-os: ');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const dim = s => `\x1b[2m${s}\x1b[22m`;

/**
 * Create a terminal inside `el` (which must have a size). Options:
 *   cwd, run, cmd, env, fontSize, termTheme ('dark'|'light'), xtermTheme (overrides), onTitle(title), onExit(code), autoStart (default true)
 * Returns {term, run, write, focus, fit, restart, dispose, get ready}.
 */
export async function createTerminal(el, opts = {}, os = window.QuartoOS) {
  await loadAppCSS(os);
  const { Terminal, FitAddon, WebLinksAddon } = await loadXterm(os);
  const theme = { ...(THEMES[opts.termTheme || opts.terminalTheme || 'dark'] || THEMES.dark), ...(opts.xtermTheme || {}) };

  const host = h('div.qos-term-host');
  host.style.background = theme.background;
  el.appendChild(host);

  const term = new Terminal({
    fontFamily: opts.fontFamily || FONT,
    fontSize: +opts.fontSize || 13,
    lineHeight: 1.12,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    scrollback: 5000,
    theme,
    allowProposedApi: false,
    drawBoldTextInBrightColors: true,
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: isMac,
    smoothScrollDuration: 0,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  if (WebLinksAddon) {
    try { term.loadAddon(new WebLinksAddon((e, uri) => { e.preventDefault(); window.open(uri, '_blank', 'noopener'); })); } catch (e) { /* optional */ }
  }
  term.open(host);

  let disposed = false, session = null, state = 'init', vm = null;
  let queue = [], ready = false, readyTimer = 0, gotData = false;
  const offs = [];

  // ---------- sizing
  const fit = () => {
    if (disposed || !host.isConnected || !host.clientWidth || !host.clientHeight) return;
    try {
      const d = fitAddon.proposeDimensions();
      if (d && d.cols > 1 && d.rows > 0 && (d.cols !== term.cols || d.rows !== term.rows)) term.resize(d.cols, d.rows);
    } catch (e) { /* hidden */ }
  };
  let fitRaf = 0;
  const scheduleFit = () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fit); };
  offs.push(onResize(host, scheduleFit));
  fit();
  term.onResize(({ cols, rows }) => { if (session) try { session.resize(cols, rows); } catch (e) { /* ignore */ } });

  // ---------- keyboard: copy / paste friendly, never leak to reveal.js
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (ctrl && e.code === 'Backquote') return false;                       // VS Code panel toggle
    if (ctrl && e.shiftKey && e.code === 'KeyC') { if (term.hasSelection()) copyText(term.getSelection()); e.preventDefault(); return false; }
    if (ctrl && e.shiftKey && e.code === 'KeyV') return false;               // browser paste → xterm paste handler
    if (!isMac && ctrl && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      copyText(term.getSelection()); term.clearSelection(); e.preventDefault(); return false;
    }
    if (!isMac && ctrl && !e.shiftKey && e.code === 'KeyV') return false;
    return true;
  });

  term.onTitleChange(t => { if (t && opts.onTitle) opts.onTitle(tidyTitle(t)); });

  // ---------- input
  term.onData(d => {
    if (state === 'exited') { restart(); return; }
    if (session) session.write(d);
  });
  term.onBinary(d => {
    if (!session) return;
    const b = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 255;
    session.write(b);
  });

  // ---------- run queue
  function flush() {
    if (!ready || !session) return;
    const q = queue; queue = [];
    for (const t of q) session.write(t.replace(/\r?\n/g, '\r').replace(/\r+$/, '') + '\r');
  }
  // The shell is "ready" once it printed something that looks like a prompt and then went quiet
  // (typing earlier makes the tty echo the text before readline redraws it).
  let tail = '';
  const tdec = new TextDecoder();
  function markData(d) {
    gotData = true;
    if (ready) return;
    tail = (tail + stripAnsi(tdec.decode(d, { stream: true }))).slice(-200);
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { ready = true; flush(); }, /[$#%>❯›]\s*$/.test(tail) ? 80 : 1500);
  }

  // ---------- boot status
  let spin = 0, spinTimer = 0, curStatus = '', printedBoot = false;
  function statusLine(sym, text) { term.write(`\r\x1b[2K  ${sym} ${text}`); }
  function onStatus(s) {
    if (!printedBoot || disposed) return;
    s = String(s || '').trim();
    if (!s || s === curStatus) return;
    const stem = x => x.replace(/[\d.,]+\s*(%|[KMG]?B|s)?/g, '#');
    if (curStatus && curStatus !== PLACEHOLDER && stem(curStatus) !== stem(s)) { statusLine('\x1b[32m✓\x1b[39m', dim(curStatus)); term.write('\r\n'); }
    curStatus = s;
    statusLine(`\x1b[36m${SPIN[spin]}\x1b[39m`, s);
  }
  function startBootLog(vmObj) {
    printedBoot = true;
    term.write(`\x1b[1mQuarto OS\x1b[22m ${dim('· starting the Linux VM (first start can take a little while)')}\r\n\r\n`);
    curStatus = '';
    onStatus(vmObj && typeof vmObj.status === 'string' && vmObj.status ? vmObj.status : PLACEHOLDER);
    spinTimer = setInterval(() => { spin = (spin + 1) % SPIN.length; if (curStatus) statusLine(`\x1b[36m${SPIN[spin]}\x1b[39m`, curStatus); }, 90);
  }
  function stopBootLog(ok) {
    clearInterval(spinTimer); spinTimer = 0;
    if (!printedBoot) return;
    if (ok) { term.write('\x1b[2J\x1b[3J\x1b[H'); } // clean screen for the shell
    else if (curStatus) { statusLine('\x1b[31m✗\x1b[39m', dim(curStatus)); term.write('\r\n'); }
    printedBoot = false;
  }

  function printError(title, e) {
    const msg = errMsg(e);
    term.write(`\r\n\x1b[1;31m✗ ${title}\x1b[0m\r\n`);
    for (const line of msg.split(/\r?\n/)) term.write(`  ${line}\r\n`);
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
      term.write(`\r\n${dim('  This page is not cross-origin isolated (COOP/COEP headers are missing),')}\r\n`);
      term.write(`${dim('  which the in-browser Linux VM requires. Serve the site with those headers')}\r\n`);
      term.write(`${dim('  or enable the coi-serviceworker (quarto-os: coi: true) and reload.')}\r\n`);
    }
  }

  // ---------- lifecycle
  async function start() {
    state = 'booting';
    try {
      if (!os || typeof os.vm !== 'function') throw new Error('QuartoOS.vm() is not available on this page.');
      const vmP = os.vm();
      // Show the boot log only if the VM isn't up almost immediately.
      const quick = await Promise.race([
        Promise.resolve(vmP).then(v => Promise.resolve(v.ready).then(() => true)),
        new Promise(r => setTimeout(() => r(false), 120)),
      ]);
      if (!quick && !disposed) {
        startBootLog(null);
        vm = await vmP;
        if (disposed) return;
        offs.push(listen(vm, 'status', onStatus));
        if (typeof vm.status === 'string' && vm.status) onStatus(vm.status);
        await vm.ready;
      } else vm = await vmP;
      stopBootLog(true);
    } catch (e) {
      stopBootLog(false);
      state = 'failed';
      if (!disposed) printError('Could not start the Linux VM', e);
      return;
    }
    if (!disposed) await openShell();
  }

  async function openShell() {
    if (disposed) return;
    state = 'starting';
    ready = false; gotData = false; tail = '';
    fit();
    const base = { cols: term.cols, rows: term.rows, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(opts.env || {}) } };
    if (opts.cmd) base.cmd = opts.cmd;
    let s;
    try {
      s = await vm.openSession({ ...base, cwd: opts.cwd || '~' });
    } catch (e) {
      if (opts.cwd && opts.cwd !== '~') {
        term.write(`\x1b[33mquarto-os: cannot open ${opts.cwd}: ${errMsg(e)}\x1b[0m\r\n`);
        try { s = await vm.openSession({ ...base, cwd: '~' }); } catch (e2) { e = e2; }
      }
      if (!s) { state = 'failed'; printError('Could not open a shell', e); return; }
    }
    if (disposed) { try { s.close(); } catch (e) { /* ignore */ } return; }
    session = s;
    state = 'running';
    s.onData(d => { if (session === s && !disposed) { term.write(d); markData(d); } });
    s.onExit(code => {
      if (session !== s || disposed) return;
      session = null; ready = false;
      state = 'exited';
      term.write(`\x1b[0m\r\n[Process completed${code ? ` with exit code ${code}` : ''}]\r\n${dim('Press any key to start a new shell.')}`);
      if (opts.onExit) opts.onExit(code);
    });
    // In case the shell prints nothing for a while, still release queued commands.
    if (!gotData) readyTimer = setTimeout(() => { if (!ready) { ready = true; flush(); } }, 2500);
    if (term.cols && term.rows) try { s.resize(term.cols, term.rows); } catch (e) { /* ignore */ }
  }

  function restart() {
    if (disposed || state === 'starting' || state === 'running') return;
    term.write('\r\n');
    if (vm) openShell(); else start();
  }

  if (opts.run) queue.push(String(opts.run));

  const api = {
    term,
    get session() { return session; },
    get ready() { return ready; },
    run(text) {
      if (text == null || text === '') return;
      queue.push(String(text));
      if (state === 'exited') restart();
      flush();
    },
    write(text) { if (session) session.write(text); },
    focus() { try { term.focus(); } catch (e) { /* ignore */ } },
    fit: scheduleFit,
    restart,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(spinTimer); clearTimeout(readyTimer); cancelAnimationFrame(fitRaf);
      for (const off of offs) off();
      if (session) { try { session.close(); } catch (e) { /* ignore */ } }
      session = null;
      try { term.dispose(); } catch (e) { /* ignore */ }
      host.remove();
    },
  };
  if (opts.autoStart !== false) start();
  return api;
}

/** App contract: Terminal window. */
export async function mount(win, opts = {}, os = window.QuartoOS) {
  await loadAppCSS(os);
  const root = mountRoot(win, 'qos-term');
  const explicitTitle = !!opts.title;
  const cwd = opts.cwd || '~';
  if (!explicitTitle) win.setTitle(`user@quarto-os: ${cwd}`);
  const t = await createTerminal(root, {
    ...opts,
    onTitle: explicitTitle ? null : title => win.setTitle(title),
  }, os);
  // Clicking the window chrome (title bar) makes the terminal the key view, like macOS.
  const onChrome = e => { if (!root.contains(e.target) && !(e.target.closest && e.target.closest('button'))) setTimeout(() => t.focus()); };
  win.el.addEventListener('pointerup', onChrome);
  const offResize = listen(win, 'resize', () => t.fit());
  return {
    focus: () => t.focus(),
    run: text => t.run(text),
    terminal: t,
    dispose() { offResize(); win.el.removeEventListener('pointerup', onChrome); t.dispose(); },
  };
}
