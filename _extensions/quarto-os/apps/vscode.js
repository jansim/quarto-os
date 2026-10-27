// Quarto OS — "VS Code, bare minimum": Monaco (CDN) + file tree + tabs + git Source Control
// + integrated terminal, all backed by the shared Linux VM.

import {
  h, ICONS, iconEl, loadAppCSS, mountRoot, listen, errMsg, expandHome, tildify, join, dirname, basename,
  extname, isInside, shq, IMAGE_EXT, looksBinary, showMenu, dialog, copyText, openApp, onResize,
  watchManager, debounce, isMac,
} from './common.js';
import { createTerminal } from './terminal.js';

import { MONACO_VERSION } from './versions.js';
export { MONACO_VERSION };
const DEFAULT_VS = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;
const EDITOR_FONT = 'Menlo, Monaco, "SF Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';
const THEME = 'qos-dark-modern';
const MOD = isMac ? '⌘' : 'Ctrl+';
const HIDE = new Set(['.git', '.DS_Store', 'Thumbs.db', '.svn', '.hg']);   // VS Code's files.exclude defaults

// ------------------------------------------------------------------ Monaco loader (once per page)
let monacoP = null;
function vsBase(os) {
  const c = os && os.config && os.config.cdn && os.config.cdn.monaco;
  return String(c || DEFAULT_VS).replace(/\/+$/, '');
}
export function loadMonaco(os) {
  if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);
  if (monacoP) return monacoP;
  const vs = vsBase(os);
  const workerBase = vs.replace(/\/vs$/, '') + '/';
  if (!window.MonacoEnvironment) {
    window.MonacoEnvironment = {
      // Same-origin blob worker that importScripts the CDN worker: works under COEP
      // (jsDelivr sends CORP: cross-origin). If it fails Monaco falls back to the main thread.
      getWorker(_id, label) {
        const src = `self.MonacoEnvironment={baseUrl:${JSON.stringify(workerBase)}};importScripts(${JSON.stringify(vs + '/base/worker/workerMain.js')});`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(url, { name: label });
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return w;
      },
    };
  }
  monacoP = new Promise((resolve, reject) => {
    const boot = () => {
      const req = window.require;
      if (!req || typeof req.config !== 'function') { reject(new Error('Monaco AMD loader unavailable')); return; }
      req.config({ paths: { vs } });
      req(['vs/editor/editor.main'], () => {
        const m = window.monaco;
        if (!m) { reject(new Error('Monaco failed to initialise')); return; }
        // Keep UMD libraries loaded later from registering as anonymous AMD modules.
        try { if (window.define && window.define.amd) delete window.define.amd; } catch (e) { /* ignore */ }
        defineTheme(m);
        resolve(m);
      }, err => reject(new Error('Could not load Monaco: ' + errMsg(err))));
    };
    if (window.require && typeof window.require.config === 'function' && window.define && window.define.amd) { boot(); return; }
    // A foreign AMD define (e.g. require.js) would stop Monaco's loader from initialising.
    if (window.define && window.define.amd) { window.define = undefined; window.require = undefined; }
    const s = document.createElement('script');
    s.src = vs + '/loader.js';
    s.onload = boot;
    s.onerror = () => reject(new Error(`Could not load the Monaco editor from ${vs} (offline or blocked?)`));
    document.head.appendChild(s);
  }).catch(e => { monacoP = null; throw e; });
  return monacoP;
}

function defineTheme(m) {
  m.editor.defineTheme(THEME, {
    base: 'vs-dark', inherit: true,
    rules: [{ token: '', foreground: 'CCCCCC' }],
    colors: {
      'editor.background': '#1F1F1F', 'editor.foreground': '#CCCCCC', 'editorGutter.background': '#1F1F1F',
      'editorLineNumber.foreground': '#6E7681', 'editorLineNumber.activeForeground': '#CCCCCC',
      'editor.lineHighlightBorder': '#282828', 'editor.selectionBackground': '#264F78', 'editor.inactiveSelectionBackground': '#3A3D41',
      'editorCursor.foreground': '#AEAFAD', 'editorIndentGuide.background1': '#404040', 'editorIndentGuide.activeBackground1': '#707070',
      'editorWidget.background': '#202020', 'editorWidget.border': '#313131', 'editorSuggestWidget.background': '#202020',
      'editorSuggestWidget.border': '#454545', 'editorSuggestWidget.selectedBackground': '#04395E', 'editorHoverWidget.background': '#202020',
      'editorHoverWidget.border': '#454545', 'input.background': '#313131', 'input.border': '#3C3C3C', 'focusBorder': '#0078D4',
      'scrollbarSlider.background': '#79797966', 'scrollbarSlider.hoverBackground': '#646464B3', 'scrollbarSlider.activeBackground': '#BFBFBF66',
      'editorOverviewRuler.border': '#00000000', 'minimap.background': '#1F1F1F', 'diffEditor.border': '#2B2B2B', 'widget.border': '#313131',
      'list.hoverBackground': '#2A2D2E', 'list.activeSelectionBackground': '#04395E', 'quickInput.background': '#222222',
      'editorStickyScroll.background': '#1F1F1F', 'menu.background': '#1F1F1F', 'menu.border': '#454545',
    },
  });
}

// ------------------------------------------------------------------ git exec guard (shared by all VS Code windows)
// Our own `vm.exec` calls make the VM emit 'activity'; ignore activity right after them to avoid refresh loops.
let execBusy = 0, execEnd = 0;
const selfInduced = () => execBusy > 0 || Date.now() - execEnd < 1500;
async function vmExec(vm, cmd, cwd) {
  execBusy++;
  try { return await vm.exec(cmd, { cwd }); } finally { execBusy--; execEnd = Date.now(); }
}

// ------------------------------------------------------------------ file icons (Seti-like glyphs)
const GLYPHS = {
  js: ['JS', '#cbcb41'], mjs: ['JS', '#cbcb41'], cjs: ['JS', '#cbcb41'], jsx: ['JSX', '#519aba'], ts: ['TS', '#519aba'], tsx: ['TSX', '#519aba'],
  json: ['{}', '#cbcb41'], md: ['M↓', '#519aba'], qmd: ['Q', '#75aadb'], rmd: ['R', '#519aba'], py: ['py', '#519aba'], ipynb: ['nb', '#e37933'],
  html: ['<>', '#e37933'], htm: ['<>', '#e37933'], xml: ['<>', '#e37933'], css: ['#', '#519aba'], scss: ['#', '#f55385'],
  sh: ['$', '#8dc149'], bash: ['$', '#8dc149'], zsh: ['$', '#8dc149'], c: ['C', '#519aba'], h: ['h', '#a074c4'], cpp: ['C+', '#519aba'],
  java: ['J', '#cc3e44'], rs: ['rs', '#e37933'], go: ['go', '#519aba'], rb: ['rb', '#cc3e44'], r: ['R', '#519aba'], lua: ['lua', '#519aba'],
  yml: ['!', '#a074c4'], yaml: ['!', '#a074c4'], toml: ['⚙', '#6d8086'], ini: ['⚙', '#6d8086'], cfg: ['⚙', '#6d8086'], conf: ['⚙', '#6d8086'],
  txt: ['≡', '#a0a0a0'], log: ['≡', '#6d8086'], csv: ['≡', '#8dc149'], sql: ['db', '#f55385'],
  png: ['▣', '#a074c4'], jpg: ['▣', '#a074c4'], jpeg: ['▣', '#a074c4'], gif: ['▣', '#a074c4'], svg: ['▣', '#cbcb41'], webp: ['▣', '#a074c4'],
};
const NAMED = {
  '.gitignore': ['◆', '#e37933'], '.gitattributes': ['◆', '#e37933'], '.gitmodules': ['◆', '#e37933'], 'Makefile': ['M', '#e37933'],
  'Dockerfile': ['D', '#519aba'], 'LICENSE': ['§', '#cbcb41'], '.bashrc': ['$', '#8dc149'], '.profile': ['$', '#8dc149'], '.bash_profile': ['$', '#8dc149'],
  'package.json': ['{}', '#8dc149'], '_quarto.yml': ['Q', '#75aadb'],
};
function fileGlyph(name) {
  const g = NAMED[name] || GLYPHS[extname(name)];
  const el = h('span.qv-ficon');
  if (g) { el.textContent = g[0]; el.style.color = g[1]; if (g[0].length > 2) el.classList.add('tiny'); else if (g[0].length === 2) el.classList.add('small'); }
  else { el.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5.2h3.4M6 8h4.5M6 10.3h4.5"/></svg>'; el.style.color = '#8a8a8a'; }
  return el;
}

function unquoteGit(p) {
  if (!p.startsWith('"')) return p;
  const s = p.slice(1, -1), bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { for (const b of new TextEncoder().encode(c)) bytes.push(b); continue; }
    const n = s[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.substr(i, 3), 8)); i += 2; }
    else bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const STATUS_WORD = { M: 'Modified', A: 'Index Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked', '!': 'Conflict' };
let uriSeq = 0;

// ================================================================== mount
export async function mount(win, opts = {}, os = window.QuartoOS) {
  await loadAppCSS(os);
  const root = mountRoot(win, 'qos-vscode');
  root.tabIndex = -1;   // clicks on non-focusable parts keep keyboard focus inside the window
  const explicitTitle = !!opts.title;
  const uriAuth = 'w' + (++uriSeq);
  const monacoReady = loadMonaco(os);
  monacoReady.catch(() => {});

  let vm = null, wm = null, home = '/home/user', folder = null, disposed = false, monaco = null;
  let editor = null, diffEditor = null, fallbackTA = null;
  const offs = [];
  const tabs = [];
  let active = null;

  // ---------------------------------------------------------------- skeleton
  const actBtn = (view, icon, title) => h('div.qv-act', { 'data-view': view, title, role: 'tab', html: ICONS[icon] });
  const actExplorer = actBtn('explorer', 'files24', `Explorer (${MOD}Shift+E)`);
  const actScm = actBtn('scm', 'scm24', 'Source Control (Ctrl+Shift+G)');
  const scmBadge = h('span.qv-badge', { hidden: true });
  actScm.append(scmBadge);
  const activity = h('div.qv-activity', null, actExplorer, actScm);

  const viewBtn = (icon, title, onclick) => h('div.qv-vbtn', { title, role: 'button', html: ICONS[icon], onclick: e => { e.stopPropagation(); onclick(e); } });
  const treeEl = h('div.qv-tree', { tabindex: '0', role: 'tree' });
  const folderHead = h('div.qv-sec-head', null,
    h('span.qv-twist', { html: ICONS.chevD }), h('span.qv-sec-title', { text: '…' }),
    h('span.qv-sec-actions', null,
      viewBtn('newFile', 'New File…', () => newItem('file', selectedDir())),
      viewBtn('newFolder', 'New Folder…', () => newItem('dir', selectedDir())),
      viewBtn('refresh', 'Refresh Explorer', () => refreshTree()),
      viewBtn('collapse', 'Collapse Folders in Explorer', () => collapseAll())));
  const viewExplorer = h('div.qv-view.qv-view-explorer', null,
    h('div.qv-view-title', null, h('span', { text: 'Explorer' })), folderHead, treeEl);

  const scmMsg = h('textarea.qv-scm-msg', { rows: '1', spellcheck: 'false', placeholder: 'Message' });
  const scmCommit = h('button.qv-btn.qv-scm-commit', { type: 'button' }, h('span.qa-ic', { html: ICONS.check }), h('span', { text: 'Commit' }));
  const scmList = h('div.qv-scm-list');
  const scmBody = h('div.qv-scm-body', null, h('div.qv-scm-input', null, scmMsg, scmCommit), scmList);
  const viewScm = h('div.qv-view.qv-view-scm', { hidden: true },
    h('div.qv-view-title', null, h('span', { text: 'Source Control' }), h('span.qv-view-actions', null,
      viewBtn('check', `Commit (${MOD}Enter)`, () => commit()),
      viewBtn('refresh', 'Refresh', () => refreshGit(true)))),
    scmBody);
  const sidebar = h('div.qv-sidebar', null, viewExplorer, viewScm);
  const sash = h('div.qv-sash');

  const tabsEl = h('div.qv-tabs', { role: 'tablist' });
  const crumbsEl = h('div.qv-crumbs');
  const monacoEl = h('div.qv-monaco');
  const diffEl = h('div.qv-diff', { hidden: true });
  const mediaEl = h('div.qv-media', { hidden: true });
  const loadingEl = h('div.qv-loading', { hidden: true }, h('div.qx-spinner'), h('span', { text: 'Loading editor…' }));
  const welcome = h('div.qv-welcome', null,
    h('div.qv-wm-logo', { html: '<svg viewBox="0 0 100 100" width="120" height="120" aria-hidden="true"><path d="M38 28 16 50l22 22M62 28l22 22-22 22" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
    h('div.qv-wm-keys', null,
      ...[['Show Explorer', `${MOD}Shift+E`], ['Source Control', isMac ? '⌃⇧G' : 'Ctrl+Shift+G'], ['Toggle Terminal', isMac ? '⌃`' : 'Ctrl+`'], ['Save File', `${MOD}S`], ['Command Palette', 'F1']]
        .map(([a, k]) => h('div.qv-wm-row', null, h('span', { text: a }), h('kbd', { text: k })))));
  const editorsEl = h('div.qv-editors', null, monacoEl, diffEl, mediaEl, welcome, loadingEl);
  const termBody = h('div.qv-term-body');
  const panelSash = h('div.qv-panel-sash');
  const panel = h('div.qv-panel', { hidden: true }, panelSash,
    h('div.qv-panel-head', null, h('div.qv-panel-tab.on', { text: 'Terminal' }), h('span.qv-flex'),
      viewBtn('plus', 'New Terminal (restart shell)', () => newTerminal()),
      viewBtn('trash', 'Kill Terminal', () => killTerminal()),
      viewBtn('chevU', 'Maximize Panel Size', e => { panel.classList.toggle('max'); e.currentTarget.innerHTML = panel.classList.contains('max') ? ICONS.chevD : ICONS.chevU; }),
      viewBtn('close', 'Hide Panel', () => togglePanel(false))),
    termBody);
  const main = h('div.qv-main', null, tabsEl, crumbsEl, editorsEl, panel);

  const sbItem = (cls, title, onclick) => h('div.qv-sb-item.' + cls, { title, onclick, role: onclick ? 'button' : null });
  const sbBranch = sbItem('qv-sb-branch', 'Source Control', () => showView('scm', true));
  const sbPos = sbItem('qv-sb-pos', 'Go to Line/Column');
  const sbIndent = sbItem('qv-sb-indent', 'Select Indentation');
  const sbEnc = sbItem('qv-sb-enc', 'Select Encoding'); sbEnc.textContent = 'UTF-8';
  const sbEol = sbItem('qv-sb-eol', 'Select End of Line Sequence');
  const sbLang = sbItem('qv-sb-lang', 'Select Language Mode');
  const sbTerm = sbItem('qv-sb-term', `Toggle Terminal (${isMac ? '⌃`' : 'Ctrl+`'})`, () => togglePanel());
  sbTerm.innerHTML = ICONS.terminal;
  const status = h('div.qv-status', null, sbBranch, h('span.qv-flex'), sbPos, sbIndent, sbEnc, sbEol, sbLang, sbTerm);
  const notifs = h('div.qv-notifs');
  root.append(h('div.qv-body', null, activity, sidebar, sash, main), status, notifs);

  // ---------------------------------------------------------------- layout behaviour
  let sideW = 220, userToggledSide = false;
  const setSideW = w => { sideW = Math.max(140, Math.min(w, root.clientWidth - 200)); sidebar.style.width = sideW + 'px'; };
  setSideW(+opts.sidebarWidth || 220);
  offs.push(onResize(root, (w, hh) => {
    root.classList.toggle('qv-narrow', w < 620);
    root.classList.toggle('qv-tiny', w < 440);
    root.classList.toggle('qv-short', hh < 360);
    if (!userToggledSide) root.classList.toggle('qv-side-hidden', w < 560);
    if (editor) editor.updateOptions({ minimap: { enabled: monacoEl.clientWidth > 760 } });
    if (sideW > w - 200) setSideW(w - 200);
  }));
  dragSash(sash, 'x', d => setSideW(sideW + d));
  let panelH = 0;
  dragSash(panelSash, 'y', d => {
    const total = main.clientHeight - 60;
    panelH = Math.max(80, Math.min(total, (panelH || panel.clientHeight) - d));
    panel.style.height = panelH + 'px';
  });
  function dragSash(el, axis, cb) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let last = axis === 'x' ? e.clientX : e.clientY;
      const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1) || 1;
      el.classList.add('active');
      const mv = ev => { const cur = axis === 'x' ? ev.clientX : ev.clientY; cb((cur - last) / scale); last = cur; };
      const up = () => { el.classList.remove('active'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  }

  function showView(v, ensure = false) {
    const cur = root.classList.contains('qv-side-hidden') ? null : (viewScm.hidden ? 'explorer' : 'scm');
    if (cur === v) { if (!ensure) toggleSidebar(); return; }
    if (root.classList.contains('qv-side-hidden')) toggleSidebar(true);
    viewExplorer.hidden = v !== 'explorer';
    viewScm.hidden = v !== 'scm';
    actExplorer.classList.toggle('on', v === 'explorer');
    actScm.classList.toggle('on', v === 'scm');
    if (v === 'scm') refreshGit();
  }
  function toggleSidebar(force) {
    userToggledSide = true;
    const hide = force === undefined ? !root.classList.contains('qv-side-hidden') : !force;
    root.classList.toggle('qv-side-hidden', hide);
    actExplorer.classList.toggle('on', !hide && !viewExplorer.hidden);
    actScm.classList.toggle('on', !hide && !viewScm.hidden);
  }
  actExplorer.addEventListener('click', () => showView('explorer'));
  actScm.addEventListener('click', () => showView('scm'));
  actExplorer.classList.add('on');

  // ---------------------------------------------------------------- keyboard (capture: before Monaco / xterm)
  root.addEventListener('keydown', e => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && k === 's') { e.preventDefault(); e.stopPropagation(); save(active); }
    else if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') { e.preventDefault(); e.stopPropagation(); togglePanel(); }
    else if (mod && !e.shiftKey && !e.altKey && k === 'b') { e.preventDefault(); e.stopPropagation(); toggleSidebar(); }
    else if (mod && e.shiftKey && k === 'e') { e.preventDefault(); e.stopPropagation(); showView('explorer', true); treeEl.focus(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'g') { e.preventDefault(); e.stopPropagation(); showView('scm', true); }
  }, true);

  // ---------------------------------------------------------------- notifications
  function notify(message, type = 'info', ms) {
    const n = h('div.qv-notif.' + type, null, h('span.qv-notif-ic', { html: ICONS[type] || ICONS.info }),
      h('div.qv-notif-msg', { text: message }), h('span.qv-vbtn', { html: ICONS.close, title: 'Clear Notification', onclick: () => n.remove() }));
    notifs.append(n);
    while (notifs.children.length > 3) notifs.firstChild.remove();
    setTimeout(() => n.remove(), ms || (type === 'error' ? 15000 : 6000));
  }

  // ---------------------------------------------------------------- init
  updateStatus();
  const ready = init();
  async function init() {
    loadingEl.hidden = false; welcome.hidden = true;
    loadingEl.lastChild.textContent = 'Starting Linux…';
    try {
      vm = await os.vm();
      offs.push(listen(vm, 'status', s => { if (!folder && s) loadingEl.lastChild.textContent = String(s); }));
      await vm.ready;
    } catch (e) {
      loadingEl.hidden = true;
      treeEl.replaceChildren(h('div.qv-tree-msg', { text: 'The Linux VM could not be started: ' + errMsg(e) }));
      notify('The Linux VM could not be started: ' + errMsg(e), 'error', 60000);
      return;
    }
    if (disposed) return;
    home = vm.home || home;
    wm = watchManager(vm);
    folder = expandHome(opts.folder || '~', home);
    const st = await vm.stat(folder).catch(() => null);
    if (!st || st.type !== 'dir') {
      notify(`The folder ${tildify(folder, home)} does not exist; opened your home folder instead.`, 'warning');
      folder = home;
    }
    folderHead.querySelector('.qv-sec-title').textContent = basename(folder).toUpperCase();
    updateTitle();
    offs.push(listen(vm, 'activity', () => { if (!selfInduced()) scheduleGit(); }));
    loadingEl.lastChild.textContent = 'Loading editor…';
    await refreshTree();
    refreshGit();
    try {
      monaco = await monacoReady;
      if (disposed) return;
      createEditor();
    } catch (e) {
      notify(errMsg(e) + ' — using a plain text editor instead.', 'warning', 12000);
      createFallbackEditor();
    }
    loadingEl.hidden = true;
    const files = String(opts.open || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const f of files) await openFile(f.startsWith('/') || f.startsWith('~') ? expandHome(f, home) : join(folder, f), { preview: false, focus: false });
    if (!files.length) updateEditorArea();
    if (opts.terminal === true || opts.terminal === 'true') togglePanel(true, false);
  }

  // ---------------------------------------------------------------- editor
  function createEditor() {
    editor = monaco.editor.create(monacoEl, {
      model: null, theme: THEME, automaticLayout: true, fontFamily: EDITOR_FONT, fontSize: +opts.fontSize || 13, lineHeight: 19,
      minimap: { enabled: monacoEl.clientWidth > 760 }, scrollBeyondLastLine: false, smoothScrolling: true, padding: { top: 6 },
      renderLineHighlight: 'line', bracketPairColorization: { enabled: true }, stickyScroll: { enabled: false },
      overviewRulerBorder: false, scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      fixedOverflowWidgets: false, 'semanticHighlighting.enabled': false, tabSize: 4, detectIndentation: true,
    });
    monaco.editor.setTheme(THEME);
    editor.onDidChangeCursorPosition(updateStatus);
    editor.onDidChangeModelOptions?.(updateStatus);
  }
  function createFallbackEditor() {
    fallbackTA = h('textarea.qv-fallback', { spellcheck: 'false', wrap: 'off' });
    monacoEl.append(fallbackTA);
    fallbackTA.addEventListener('input', () => { if (active && active.kind === 'file') { active.text = fallbackTA.value; active.version++; pin(active); updateDirty(active); } });
    fallbackTA.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '    '); }
    });
    fallbackTA.addEventListener('keyup', updateStatus);
    fallbackTA.addEventListener('click', updateStatus);
  }

  function makeUri(path) { return monaco.Uri.from({ scheme: 'qos', authority: uriAuth, path }); }
  function langOf(path) {
    if (!monaco) return 'plaintext';
    const name = basename(path).toLowerCase(), ext = '.' + extname(name);
    for (const l of monaco.languages.getLanguages()) {
      if ((l.filenames || []).some(f => f.toLowerCase() === name)) return l.id;
      if (ext !== '.' && (l.extensions || []).some(x => x.toLowerCase() === ext)) return l.id;
    }
    return name === 'makefile' ? 'shell' : 'plaintext';
  }
  function langName(id) {
    const l = monaco && monaco.languages.getLanguages().find(x => x.id === id);
    return (l && l.aliases && l.aliases[0]) || (id === 'plaintext' ? 'Plain Text' : id);
  }

  // ---------------------------------------------------------------- tabs
  function tabKey(t) { return t.kind === 'diff' ? `diff:${t.staged ? 'i' : 'w'}:${t.path}` : t.path; }
  function findTab(key) { return tabs.find(t => tabKey(t) === key); }
  const isDirty = t => t.kind === 'file' && (t.model ? t.model.getAlternativeVersionId() !== t.savedVersion : t.version !== t.savedVersion);

  async function openFile(path, { preview = true, focus = true, line } = {}) {
    if (!vm) return;
    path = expandHome(path, home);
    let t = findTab(path);
    if (t) { if (!preview) pin(t); activate(t, focus); return t; }
    let bytes, st;
    try { [bytes, st] = await Promise.all([vm.readFile(path), vm.stat(path).catch(() => null)]); }
    catch (e) { notify(`Unable to open '${basename(path)}': ${errMsg(e)}`, 'error'); return null; }
    if (disposed) return null;
    t = findTab(path);
    if (t) { activate(t, focus); return t; }
    const mime = IMAGE_EXT[extname(path)];
    t = { path, title: basename(path), preview, mtime: st && st.mtime, size: st && st.size };
    if (mime) { t.kind = 'image'; t.url = URL.createObjectURL(new Blob([bytes], { type: mime })); t.bytes = bytes.length; }
    else if (looksBinary(bytes)) { t.kind = 'binary'; t.bytes = bytes.length; }
    else {
      t.kind = 'file';
      const text = new TextDecoder().decode(bytes);
      if (monaco) {
        const uri = makeUri(path);
        const old = monaco.editor.getModel(uri);
        if (old) old.dispose();
        t.model = monaco.editor.createModel(text, langOf(path), uri);
        t.savedVersion = t.model.getAlternativeVersionId();
        t.model.onDidChangeContent(() => { pin(t); updateDirty(t); });
        t.model.onDidChangeOptions?.(() => { if (active === t) updateStatus(); });
      } else { t.text = text; t.version = 0; t.savedVersion = 0; }
    }
    t.unwatch = wm.watch(dirname(path), list => onDirListing(t, list));
    // a preview tab is replaced by the next preview
    const prev = preview && tabs.find(x => x.preview && !isDirty(x));
    if (prev) { const i = tabs.indexOf(prev); disposeTab(prev); tabs.splice(i, 1, t); }
    else { const i = active ? tabs.indexOf(active) + 1 : tabs.length; tabs.splice(i, 0, t); }
    activate(t, focus);
    if (line && editor) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
    return t;
  }

  function pin(t) { if (t.preview) { t.preview = false; renderTabs(); } }

  function activate(t, focus = true) {
    if (active && active !== t && active.kind === 'file' && editor && active.model) active.viewState = editor.saveViewState();
    active = t;
    updateEditorArea();
    if (t && t.kind === 'file') {
      if (editor && t.model) {
        editor.setModel(t.model);
        if (t.viewState) editor.restoreViewState(t.viewState);
        if (focus) editor.focus();
      } else if (fallbackTA) { fallbackTA.value = t.text; if (focus) fallbackTA.focus(); }
    } else if (t && t.kind === 'diff') showDiff(t);
    else if (t) showMedia(t);
    renderTabs();
    revealInTree(t && t.kind !== 'diff' ? t.path : null);
    updateStatus();
    updateTitle();
  }

  function updateEditorArea() {
    const k = active && active.kind;
    monacoEl.hidden = k !== 'file';
    diffEl.hidden = k !== 'diff';
    mediaEl.hidden = !(k === 'image' || k === 'binary');
    welcome.hidden = !!active || !loadingEl.hidden;
    crumbsEl.hidden = !active;
    if (editor && k !== 'file') editor.setModel(null);
  }

  function renderTabs() {
    tabsEl.replaceChildren(...tabs.map(t => {
      const dirty = isDirty(t);
      const close = h('span.qv-tab-close', { title: 'Close', html: dirty ? ICONS.dot : ICONS.close });
      close.addEventListener('mouseenter', () => { close.innerHTML = ICONS.close; });
      close.addEventListener('mouseleave', () => { close.innerHTML = isDirty(t) ? ICONS.dot : ICONS.close; });
      close.addEventListener('click', e => { e.stopPropagation(); closeTab(t); });
      const icon = t.kind === 'diff' ? h('span.qv-ficon.qv-diff-ic', { html: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5.5 2.5v6M2.5 5.5h6M8 12.5h5.5"/></svg>' }) : fileGlyph(t.title);
      const el = h('div.qv-tab' + (t === active ? '.on' : '') + (dirty ? '.dirty' : '') + (t.preview ? '.preview' : '') + (t.deleted ? '.deleted' : ''),
        { role: 'tab', title: t.kind === 'diff' ? `${tildify(t.path, home)} (${t.staged ? 'Index' : 'Working Tree'})` : tildify(t.path, home) },
        icon, h('span.qv-tab-label', { text: t.kind === 'diff' ? `${t.title} (${t.staged ? 'Index' : 'Working Tree'})` : t.title }), close);
      el.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
      el.addEventListener('click', () => activate(t));
      el.addEventListener('dblclick', () => pin(t));
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Close', action: () => closeTab(t) },
          { label: 'Close Others', action: async () => { for (const x of tabs.filter(x => x !== t)) if (!(await closeTab(x))) break; } },
          { label: 'Close All', action: async () => { for (const x of [...tabs]) if (!(await closeTab(x))) break; } },
          '-',
          { label: 'Copy Path', action: () => copyText(t.path) },
          { label: 'Reveal in Explorer View', action: () => { showView('explorer', true); revealInTree(t.path); } },
        ], { variant: 'vscode' });
      });
      return el;
    }));
    const on = tabsEl.querySelector('.qv-tab.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    renderCrumbs();
  }

  function renderCrumbs() {
    if (!active) { crumbsEl.replaceChildren(); return; }
    const p = active.path;
    const rel = folder && isInside(p, folder) ? [basename(folder), ...p.slice(folder.length + 1).split('/')] : p.split('/').filter(Boolean);
    const parts = [];
    rel.forEach((seg, i) => {
      if (i) parts.push(h('span.qv-crumb-sep', { html: ICONS.chevR }));
      parts.push(h('span.qv-crumb', null, i === rel.length - 1 ? fileGlyph(seg) : null, h('span', { text: seg })));
    });
    crumbsEl.replaceChildren(...parts);
  }

  async function closeTab(t) {
    if (isDirty(t)) {
      const r = await dialog(root, {
        title: `Do you want to save the changes you made to ${t.title}?`, message: 'Your changes will be lost if you don\'t save them.',
        buttons: [{ label: 'Save', value: 'save', primary: true }, { label: 'Don\'t Save', value: 'discard' }, { label: 'Cancel', value: null, cancel: true }],
      });
      if (!r) return false;
      if (r === 'save' && !(await save(t))) return false;
    }
    const i = tabs.indexOf(t);
    if (i < 0) return true;
    tabs.splice(i, 1);
    disposeTab(t);
    if (active === t) { active = null; activate(tabs[Math.min(i, tabs.length - 1)] || null); }
    else renderTabs();
    if (!tabs.length) { active = null; updateEditorArea(); renderTabs(); updateStatus(); updateTitle(); }
    return true;
  }
  function disposeTab(t) {
    if (t.unwatch) t.unwatch();
    if (t.url) URL.revokeObjectURL(t.url);
    if (t.model) { try { t.model.dispose(); } catch (e) { /* ignore */ } }
    if (t.orig) { try { t.orig.dispose(); t.mod.dispose(); } catch (e) { /* ignore */ } }
  }

  function updateDirty(t) {
    const el = tabsEl.children[tabs.indexOf(t)];
    if (!el) return;
    const d = isDirty(t);
    if (el.classList.contains('dirty') !== d) renderTabs();
    if (t === active) updateTitle();
  }

  async function save(t) {
    if (!t || t.kind !== 'file' || !vm) return false;
    const text = t.model ? t.model.getValue() : t.text;
    const ver = t.model ? t.model.getAlternativeVersionId() : t.version;
    try { await vm.writeFile(t.path, text); } catch (e) { notify(`Failed to save '${t.title}': ${errMsg(e)}`, 'error'); return false; }
    t.savedVersion = ver;
    t.deleted = false;
    pin(t);
    updateDirty(t);
    renderTabs();
    const st = await vm.stat(t.path).catch(() => null);
    if (st) { t.mtime = st.mtime; t.size = st.size; }
    scheduleGit();
    return true;
  }

  async function onDirListing(t, list) {
    if (disposed || t.kind !== 'file') return;
    const e = list.find(x => x.name === basename(t.path));
    if (!e) { if (!t.deleted) { t.deleted = true; renderTabs(); } return; }
    if (t.deleted) { t.deleted = false; renderTabs(); }
    if (e.mtime === t.mtime && e.size === t.size) return;
    t.mtime = e.mtime; t.size = e.size;
    if (isDirty(t)) return;
    let text;
    try { text = await vm.readText(t.path); } catch (err) { return; }
    if (disposed || isDirty(t)) return;
    if (t.model) {
      if (text === t.model.getValue()) return;
      const vs = active === t && editor ? editor.saveViewState() : null;
      t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text }], () => null);
      t.savedVersion = t.model.getAlternativeVersionId();
      if (vs) editor.restoreViewState(vs);
    } else {
      if (text === t.text) return;
      t.text = text; t.version++; t.savedVersion = t.version;
      if (active === t && fallbackTA) fallbackTA.value = text;
    }
    updateDirty(t);
  }

  function showMedia(t) {
    if (t.kind === 'image') {
      mediaEl.replaceChildren(h('div.qv-media-img', null, h('img.qv-img', { src: t.url, alt: t.title })), h('div.qv-media-info', { text: `${t.title} · ${(t.bytes / 1000).toFixed(1)} KB` }));
    } else {
      mediaEl.replaceChildren(h('div.qv-media-msg', null,
        h('div', { text: 'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.' })));
    }
  }

  // ---------------------------------------------------------------- status bar & title
  function updateStatus() {
    const t = active;
    const showEd = t && t.kind === 'file';
    for (const el of [sbPos, sbIndent, sbEnc, sbEol, sbLang]) el.hidden = !showEd;
    if (!showEd) return;
    if (t.model && editor) {
      const p = editor.getPosition();
      const sel = editor.getSelection();
      const selLen = sel && !sel.isEmpty() ? t.model.getValueLengthInRange(sel) : 0;
      sbPos.textContent = p ? `Ln ${p.lineNumber}, Col ${p.column}${selLen ? ` (${selLen} selected)` : ''}` : '';
      const o = t.model.getOptions();
      sbIndent.textContent = `${o.insertSpaces ? 'Spaces' : 'Tab Size'}: ${o.indentSize || o.tabSize}`;
      sbEol.textContent = t.model.getEOL() === '\n' ? 'LF' : 'CRLF';
      sbLang.textContent = langName(t.model.getLanguageId());
    } else if (fallbackTA) {
      const before = fallbackTA.value.slice(0, fallbackTA.selectionStart).split('\n');
      sbPos.textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
      sbIndent.textContent = 'Spaces: 4'; sbEol.textContent = 'LF'; sbLang.textContent = 'Plain Text';
    }
  }
  function updateTitle() {
    if (explicitTitle || !folder) return;
    const t = active;
    const name = t ? (t.kind === 'diff' ? `${t.title} (${t.staged ? 'Index' : 'Working Tree'})` : t.title) : '';
    win.setTitle(`${t && isDirty(t) ? '● ' : ''}${name ? name + ' — ' : ''}${basename(folder)}`);
  }

  // ================================================================ file tree
  const tree = { expanded: new Set(), children: new Map(), watch: new Map(), sel: null, edit: null };
  const sortEntries = list => list.filter(e => !HIDE.has(e.name))
    .sort((a, b) => ((b.type === 'dir') - (a.type === 'dir')) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

  async function loadDir(dir) {
    try { tree.children.set(dir, sortEntries(await vm.ls(dir))); }
    catch (e) { tree.children.set(dir, []); }
    if (!tree.watch.has(dir)) tree.watch.set(dir, wm.watch(dir, list => { tree.children.set(dir, sortEntries(list)); renderTree(); }));
  }
  async function refreshTree() {
    tree.expanded.add(folder);
    await Promise.all([...tree.expanded].map(d => loadDir(d)));
    renderTree();
  }
  function collapseAll() {
    for (const d of [...tree.expanded]) if (d !== folder) { tree.expanded.delete(d); unwatchDir(d); }
    renderTree();
  }
  function unwatchDir(d) { const off = tree.watch.get(d); if (off) { off(); tree.watch.delete(d); } }
  async function toggleDir(dir, force) {
    const open = force === undefined ? !tree.expanded.has(dir) : force;
    if (open) { tree.expanded.add(dir); if (!tree.children.has(dir) || !tree.watch.has(dir)) await loadDir(dir); }
    else { tree.expanded.delete(dir); for (const d of [...tree.expanded]) if (isInside(d, dir) && d !== dir) tree.expanded.delete(d); unwatchDir(dir); tree.children.delete(dir); }
    renderTree();
  }

  function renderTree() {
    if (!folder) return;
    const rows = [];
    const deco = git.deco;
    const walk = (dir, depth) => {
      const kids = tree.children.get(dir) || [];
      if (tree.edit && tree.edit.mode === 'new' && tree.edit.dir === dir) rows.push(editRow(depth, tree.edit.type));
      for (const e of kids) {
        const p = join(dir, e.name);
        const isDir = e.type === 'dir';
        const open = isDir && tree.expanded.has(p);
        if (tree.edit && tree.edit.mode === 'rename' && tree.edit.path === p) { rows.push(editRow(depth, e.type, e.name)); if (open) walk(p, depth + 1); continue; }
        const d = deco.get(p) || (isDir ? deco.get(p + '/') : null);
        const row = h('div.qv-row' + (p === tree.sel ? '.sel' : '') + (active && active.path === p && active.kind !== 'diff' ? '.cur' : '') + (d ? '.git-' + d.cls : ''),
          { 'data-path': p, 'data-dir': isDir ? '1' : null, role: 'treeitem', style: { paddingLeft: (depth * 12 + 6) + 'px' }, title: tildify(p, home) },
          h('span.qv-twist', { html: isDir ? (open ? ICONS.chevD : ICONS.chevR) : '' }),
          isDir ? null : fileGlyph(e.name),
          h('span.qv-label', { text: e.name }),
          d ? h('span.qv-deco', { text: isDir ? '●' : d.letter }) : null);
        rows.push(row);
        if (open) walk(p, depth + 1);
      }
    };
    walk(folder, 0);
    if (!rows.length) rows.push(h('div.qv-tree-msg', { text: 'This folder is empty.' }));
    const st = treeEl.scrollTop;
    treeEl.replaceChildren(...rows);
    treeEl.scrollTop = st;
    const inp = treeEl.querySelector('input');
    if (inp && document.activeElement !== inp) {
      inp.focus();
      const dot = inp.value.lastIndexOf('.');
      inp.setSelectionRange(0, dot > 0 && tree.edit.type !== 'dir' ? dot : inp.value.length);
    }
  }
  function editRow(depth, type, value = '') {
    const inp = h('input.qv-tree-input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
    inp.value = value;
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(inp.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (tree.edit && tree.edit.input === inp) commitEdit(inp.value); }, 0));
    if (tree.edit) tree.edit.input = inp;
    return h('div.qv-row.editing', { style: { paddingLeft: (depth * 12 + 6) + 'px' } },
      h('span.qv-twist', { html: type === 'dir' ? ICONS.chevR : '' }), type === 'dir' ? null : fileGlyph(value || 'x.txt'), inp);
  }
  function cancelEdit() { tree.edit = null; renderTree(); treeEl.focus(); }
  async function commitEdit(name) {
    const ed = tree.edit;
    if (!ed) return;
    tree.edit = null;
    name = name.trim();
    if (!name || (ed.mode === 'rename' && name === basename(ed.path))) { renderTree(); treeEl.focus(); return; }
    if (name.includes('/') && ed.mode === 'rename') { notify('A file or folder name cannot contain "/".', 'error'); renderTree(); return; }
    const dir = ed.mode === 'new' ? ed.dir : dirname(ed.path);
    const target = join(dir, name);
    if (await vm.stat(target).catch(() => null)) { notify(`A file or folder ${name} already exists at this location. Please choose a different name.`, 'error'); renderTree(); return; }
    try {
      if (ed.mode === 'new') {
        if (ed.type === 'dir') await vm.mkdir(target);
        else { if (name.includes('/')) await vm.mkdir(dirname(target)); await vm.writeFile(target, ''); }
      } else {
        await vm.rename(ed.path, target);
        await retargetTabs(ed.path, target);
      }
    } catch (e) { notify(errMsg(e), 'error'); renderTree(); return; }
    await loadDir(dir);
    if (ed.mode === 'new' && name.includes('/')) await toggleDir(dirname(target), true);
    tree.sel = target;
    renderTree();
    if (ed.mode === 'new' && ed.type !== 'dir') openFile(target, { preview: false });
    else treeEl.focus();
    scheduleGit();
  }
  async function retargetTabs(from, to) {
    for (const t of tabs) {
      if (!isInside(t.path, from)) continue;
      const np = to + t.path.slice(from.length);
      if (t.kind === 'file' && t.model) {
        const dirty = isDirty(t), vs = active === t && editor ? editor.saveViewState() : null;
        const m = monaco.editor.createModel(t.model.getValue(), langOf(np), makeUri(np));
        m.onDidChangeContent(() => { pin(t); updateDirty(t); });
        const old = t.model;
        t.model = m; t.savedVersion = dirty ? -1 : m.getAlternativeVersionId();
        if (active === t) { editor.setModel(m); if (vs) editor.restoreViewState(vs); }
        old.dispose();
      }
      t.path = np; t.title = basename(np);
      if (t.unwatch) t.unwatch();
      if (t.kind !== 'diff') t.unwatch = wm.watch(dirname(np), list => onDirListing(t, list));
    }
    renderTabs(); updateTitle(); updateStatus();
  }

  function selectedDir() {
    const s = tree.sel;
    if (!s) return folder;
    const row = treeEl.querySelector(`[data-path="${CSS.escape(s)}"]`);
    return row && row.dataset.dir ? s : dirname(s);
  }
  async function newItem(type, dir) {
    if (!folder) return;
    showView('explorer', true);
    if (dir !== folder) await toggleDir(dir, true);
    tree.edit = { mode: 'new', type, dir };
    renderTree();
  }
  function startRename(path) {
    tree.edit = { mode: 'rename', path, type: treeEl.querySelector(`[data-path="${CSS.escape(path)}"]`)?.dataset.dir ? 'dir' : 'file' };
    renderTree();
  }
  async function deletePath(path) {
    const isDir = !!treeEl.querySelector(`[data-path="${CSS.escape(path)}"]`)?.dataset.dir;
    const ok = await dialog(root, {
      title: `Are you sure you want to delete '${basename(path)}'${isDir ? ' and its contents' : ''}?`,
      message: 'This action is irreversible!',
      buttons: [{ label: 'Delete', value: true, primary: true, danger: true }, { label: 'Cancel', value: false, cancel: true }],
    });
    if (!ok) return;
    try { await vm.remove(path); } catch (e) { notify(errMsg(e), 'error'); return; }
    for (const t of tabs.filter(t => isInside(t.path, path) && t.kind !== 'diff')) { t.savedVersion = t.model ? t.model.getAlternativeVersionId() : t.version; await closeTab(t); }
    await loadDir(dirname(path));
    renderTree();
    scheduleGit();
  }
  function revealInTree(path) {
    tree.sel = path || tree.sel;
    if (!path || !folder || !isInside(path, folder)) { renderTree(); return; }
    const need = [];
    for (let d = dirname(path); d !== folder && isInside(d, folder); d = dirname(d)) if (!tree.expanded.has(d)) need.unshift(d);
    if (!need.length) { renderTree(); scrollTreeToSel(); return; }
    Promise.all(need.map(d => { tree.expanded.add(d); return loadDir(d); })).then(() => { renderTree(); scrollTreeToSel(); });
  }
  function scrollTreeToSel() {
    const r = tree.sel && treeEl.querySelector(`[data-path="${CSS.escape(tree.sel)}"]`);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }

  treeEl.addEventListener('click', e => {
    const row = e.target.closest('.qv-row');
    if (!row || row.classList.contains('editing')) return;
    const p = row.dataset.path;
    tree.sel = p;
    if (row.dataset.dir) toggleDir(p);
    else { renderTree(); openFile(p, { preview: true, focus: false }); }
  });
  treeEl.addEventListener('dblclick', e => {
    const row = e.target.closest('.qv-row');
    if (row && !row.dataset.dir && !row.classList.contains('editing')) openFile(row.dataset.path, { preview: false, focus: true });
  });
  treeEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const row = e.target.closest('.qv-row');
    const p = row && !row.classList.contains('editing') ? row.dataset.path : null;
    if (p) { tree.sel = p; renderTree(); }
    const isDir = !p || !!(row && row.dataset.dir);
    const dir = p ? (isDir ? p : dirname(p)) : folder;
    showMenu(e.clientX, e.clientY, [
      { label: 'New File…', action: () => newItem('file', dir) },
      { label: 'New Folder…', action: () => newItem('dir', dir) },
      { label: 'Reveal in Files', action: () => openApp(os, win, 'explorer', { path: dir }) },
      { label: 'Open in Integrated Terminal', action: () => openTerminalAt(dir) },
      '-',
      { label: 'Copy Path', action: () => copyText(p || folder) },
      { label: 'Copy Relative Path', action: () => copyText(p ? p.slice(folder.length + 1) || '.' : '.') },
      p && '-',
      p && { label: 'Rename…', kbd: isMac ? '↵' : 'F2', action: () => startRename(p) },
      p && { label: 'Delete', kbd: isMac ? '⌘⌫' : 'Delete', action: () => deletePath(p) },
      !p && '-',
      !p && { label: 'Refresh', action: () => refreshTree() },
    ], { variant: 'vscode' });
  });
  treeEl.addEventListener('keydown', e => {
    if (e.target !== treeEl) return;
    const rows = [...treeEl.querySelectorAll('.qv-row[data-path]')];
    const i = rows.findIndex(r => r.dataset.path === tree.sel);
    const cur = rows[i];
    const sel = r => { if (r) { tree.sel = r.dataset.path; renderTree(); scrollTreeToSel(); } };
    let handled = true;
    if (e.key === 'ArrowDown') sel(rows[i + 1] || rows[0]);
    else if (e.key === 'ArrowUp') sel(rows[i - 1] || rows[rows.length - 1]);
    else if (e.key === 'ArrowRight' && cur && cur.dataset.dir) toggleDir(cur.dataset.path, true);
    else if (e.key === 'ArrowLeft' && cur) { if (cur.dataset.dir && tree.expanded.has(cur.dataset.path)) toggleDir(cur.dataset.path, false); else { const pd = dirname(cur.dataset.path); if (pd !== dirname(folder) && isInside(pd, folder) && pd !== folder) { tree.sel = pd; renderTree(); } } }
    else if (e.key === 'Enter' && cur) { if (isMac) startRename(cur.dataset.path); else if (cur.dataset.dir) toggleDir(cur.dataset.path); else openFile(cur.dataset.path, { preview: false }); }
    else if (e.key === ' ' && cur) { if (cur.dataset.dir) toggleDir(cur.dataset.path); else openFile(cur.dataset.path, { preview: true, focus: false }); }
    else if (e.key === 'F2' && cur) startRename(cur.dataset.path);
    else if ((e.key === 'Delete' || (isMac && e.metaKey && e.key === 'Backspace')) && cur) deletePath(cur.dataset.path);
    else handled = false;
    if (handled) e.preventDefault();
  });
  folderHead.addEventListener('click', () => {
    const coll = treeEl.hidden = !treeEl.hidden;
    folderHead.querySelector('.qv-twist').innerHTML = coll ? ICONS.chevR : ICONS.chevD;
  });

  // ================================================================ git / source control
  const git = { isRepo: null, root: null, branch: '', unborn: false, staged: [], changes: [], deco: new Map(), busy: false, again: false, error: null };
  const scheduleGit = debounce(() => refreshGit(), 250);
  let gitWatchOff = null;

  async function refreshGit(force) {
    if (!vm || !folder || disposed) return;
    if (git.busy) { git.again = true; return; }
    git.busy = true;
    try {
      const r = await vmExec(vm, 'git rev-parse --show-toplevel && git -c core.quotepath=false --no-optional-locks status --porcelain -b -uall', folder);
      if (disposed) return;
      const out = String(r.output || '').replace(/\r/g, '');
      if (r.code !== 0) {
        git.isRepo = /not a git repository/i.test(out) ? false : git.isRepo;
        git.error = git.isRepo === false ? null : out.trim();
        if (git.isRepo === false) { git.root = null; git.staged = []; git.changes = []; git.branch = ''; }
      } else {
        const lines = out.split('\n');
        const rootLine = lines.findIndex(l => l.startsWith('/'));
        git.isRepo = true; git.error = null;
        const newRoot = (lines[rootLine] || folder).trim();
        if (newRoot !== git.root) {
          git.root = newRoot;
          if (gitWatchOff) gitWatchOff();
          gitWatchOff = wm.watch(newRoot + '/.git', () => scheduleGit());
        }
        const staged = [], changes = [];
        for (const l of lines.slice(rootLine + 1)) {
          if (l.startsWith('## ')) {
            const b = l.slice(3);
            let m;
            if ((m = /^(?:No commits yet|Initial commit) on (.+)$/.exec(b))) { git.branch = m[1]; git.unborn = true; }
            else if (b.startsWith('HEAD (no branch)')) { git.branch = 'HEAD'; git.unborn = false; }
            else { git.branch = b.split('...')[0].split(' ')[0]; git.unborn = false; }
            continue;
          }
          if (l.length < 4) continue;
          const X = l[0], Y = l[1];
          let p = l.slice(3), from = null;
          const arrow = p.indexOf(' -> ');
          if (arrow >= 0 && (X === 'R' || X === 'C')) { from = unquoteGit(p.slice(0, arrow)); p = p.slice(arrow + 4); }
          p = unquoteGit(p);
          if (X === '!' ) continue;
          const abs = join(git.root, p);
          if (X === '?' && Y === '?') { changes.push({ path: abs, rel: p, st: 'U', untracked: true }); continue; }
          if ('UDA'.includes(X) && 'UDA'.includes(Y) && (X === 'U' || Y === 'U' || (X === Y && X !== ' '))) { changes.push({ path: abs, rel: p, st: '!', conflict: true }); continue; }
          if (X !== ' ') staged.push({ path: abs, rel: p, st: X, from });
          if (Y !== ' ') changes.push({ path: abs, rel: p, st: Y });
        }
        git.staged = staged; git.changes = changes;
      }
      computeDeco();
      renderScm();
      renderTree();
      updateBranch();
      refreshOpenDiff();
    } catch (e) {
      git.error = errMsg(e);
      renderScm();
    } finally {
      git.busy = false;
      if (git.again) { git.again = false; scheduleGit(); }
    }
  }

  function computeDeco() {
    const deco = new Map();
    const cls = { M: 'mod', A: 'add', D: 'del', R: 'add', C: 'add', U: 'untracked', '!': 'conflict' };
    const add = (e, staged) => {
      const letter = e.st === 'U' ? 'U' : e.st;
      if (!deco.has(e.path) || !staged) deco.set(e.path, { letter, cls: cls[e.st] || 'mod' });
      for (let d = dirname(e.path); folder && isInside(d, folder) && d !== folder; d = dirname(d)) if (!deco.has(d + '/')) deco.set(d + '/', { letter: '●', cls: cls[e.st] || 'mod' });
    };
    git.staged.forEach(e => add(e, true));
    git.changes.forEach(e => add(e, false));
    git.deco = deco;
  }

  function updateBranch() {
    const n = git.staged.length + git.changes.length;
    scmBadge.hidden = !n; scmBadge.textContent = n > 99 ? '99+' : String(n);
    if (git.isRepo) {
      sbBranch.replaceChildren(h('span.qa-ic', { html: ICONS.branch }), h('span', { text: git.branch + (n ? '*' : '') }));
      sbBranch.hidden = false;
      scmMsg.placeholder = `Message (${MOD}Enter to commit on "${git.branch}")`;
    } else sbBranch.hidden = true;
  }

  function renderScm() {
    if (git.isRepo === false) {
      scmBody.classList.add('norepo');
      scmList.replaceChildren(h('div.qv-scm-empty', null,
        h('div.qv-p', { text: 'The folder currently open doesn\'t have a git repository. You can initialize a repository which will enable source control features powered by git.' }),
        h('button.qv-btn', { type: 'button', onclick: initRepo }, 'Initialize Repository'),
        h('div.qv-p.qv-dim', { text: 'Tip: you can also run `git init` in the terminal.' })));
      return;
    }
    scmBody.classList.remove('norepo');
    if (git.isRepo === null) { scmList.replaceChildren(h('div.qv-tree-msg', { text: git.error || 'Loading…' })); return; }
    const sections = [];
    const group = (title, items, staged) => {
      const key = staged ? 'staged' : 'changes';
      const collapsed = scmCollapsed.has(key);
      const acts = h('span.qv-sec-actions', null,
        staged ? viewBtn('minus', 'Unstage All Changes', () => unstage(items)) : viewBtn('discard', 'Discard All Changes', () => discard(items)),
        staged ? null : viewBtn('plus', 'Stage All Changes', () => stage(items)));
      const head = h('div.qv-scm-group', { onclick: () => { if (collapsed) scmCollapsed.delete(key); else scmCollapsed.add(key); renderScm(); } },
        h('span.qv-twist', { html: collapsed ? ICONS.chevR : ICONS.chevD }), h('span.qv-scm-gtitle', { text: title }), acts, h('span.qv-count', { text: String(items.length) }));
      sections.push(head);
      if (collapsed) return;
      for (const it of items) {
        const dir = it.rel.includes('/') ? dirname(it.rel) : '';
        const row = h('div.qv-scm-item.git-' + ({ M: 'mod', A: 'add', D: 'del', R: 'add', U: 'untracked', '!': 'conflict' }[it.st] || 'mod'),
          { title: `${tildify(it.path, home)} • ${staged ? 'Staged ' : ''}${STATUS_WORD[it.st] || it.st}` },
          fileGlyph(basename(it.rel)), h('span.qv-scm-name', { text: basename(it.rel) }), h('span.qv-scm-dir', { text: dir }),
          h('span.qv-sec-actions', null,
            it.st !== 'D' ? viewBtn('openFile', 'Open File', () => openFile(it.path, { preview: false })) : null,
            staged ? null : viewBtn('discard', 'Discard Changes', () => discard([it])),
            staged ? viewBtn('minus', 'Unstage Changes', () => unstage([it])) : viewBtn('plus', 'Stage Changes', () => stage([it]))),
          h('span.qv-scm-st', { text: it.st }));
        row.addEventListener('click', () => openDiff(it, staged));
        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: 'Open Changes', action: () => openDiff(it, staged) },
            it.st !== 'D' && { label: 'Open File', action: () => openFile(it.path, { preview: false }) },
            '-',
            staged ? { label: 'Unstage Changes', action: () => unstage([it]) } : { label: 'Stage Changes', action: () => stage([it]) },
            !staged && { label: 'Discard Changes', action: () => discard([it]) },
            '-',
            { label: 'Copy Path', action: () => copyText(it.path) },
          ], { variant: 'vscode' });
        });
        sections.push(row);
      }
    };
    if (git.staged.length) group('Staged Changes', git.staged, true);
    if (git.changes.length) group('Changes', git.changes, false);
    if (git.error) sections.push(h('div.qv-tree-msg.err', { text: git.error }));
    scmList.replaceChildren(...sections);
  }
  const scmCollapsed = new Set();

  const relArgs = items => items.map(i => shq(i.rel)).join(' ');
  async function gitRun(cmd, what) {
    const r = await vmExec(vm, cmd, git.root || folder);
    if (r.code !== 0) notify(`Git: ${what} failed.\n${String(r.output || '').trim()}`, 'error');
    await refreshGit(true);
    return r.code === 0;
  }
  async function stage(items) {
    if (!items.length) return;
    const del = items.filter(i => i.st === 'D'), rest = items.filter(i => i.st !== 'D');
    if (rest.length) await gitRun(`git add -- ${relArgs(rest)}`, 'stage');
    if (del.length) await gitRun(`git rm -q --cached -- ${relArgs(del)}`, 'stage');
  }
  async function unstage(items) {
    if (!items.length) return;
    if (git.unborn) await gitRun(`git rm -q -r --cached -- ${relArgs(items)}`, 'unstage');
    else await gitRun(`git reset -q -- ${relArgs(items)}`, 'unstage');
  }
  async function discard(items) {
    if (!items.length) return;
    const untracked = items.filter(i => i.untracked), tracked = items.filter(i => !i.untracked && !i.conflict);
    const one = items.length === 1;
    const ok = await dialog(root, {
      title: one ? (untracked.length ? `Are you sure you want to DELETE ${basename(items[0].rel)}?` : `Are you sure you want to discard changes in ${basename(items[0].rel)}?`)
        : `Are you sure you want to discard ALL changes in ${items.length} files?`,
      message: untracked.length ? 'This is IRREVERSIBLE! This file will be FOREVER LOST if you proceed.' : 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST if you proceed.',
      buttons: [{ label: untracked.length && one ? 'Delete File' : one ? 'Discard File' : 'Discard All', value: true, primary: true, danger: true }, { label: 'Cancel', value: false, cancel: true }],
    });
    if (!ok) return;
    if (tracked.length) await gitRun(`git checkout -q -- ${relArgs(tracked)}`, 'discard');
    for (const u of untracked) { try { await vm.remove(u.path); } catch (e) { notify(errMsg(e), 'error'); } }
    await refreshGit(true);
  }
  async function commit() {
    if (!git.isRepo) return;
    const msg = scmMsg.value.trim();
    if (!msg) { scmMsg.focus(); scmMsg.classList.add('invalid'); notify('Please provide a commit message.', 'info', 3000); return; }
    let all = false;
    if (!git.staged.length) {
      if (!git.changes.length) { notify('There are no changes to commit.', 'info'); return; }
      const r = await dialog(root, {
        title: 'There are no staged changes to commit.', message: 'Would you like to stage all your changes and commit them directly?', icon: 'info',
        buttons: [{ label: 'Yes', value: true, primary: true }, { label: 'Cancel', value: false, cancel: true }],
      });
      if (!r) return;
      all = true;
    }
    scmCommit.disabled = true;
    try {
      const cwd = git.root || folder;
      let r = await vmExec(vm, `${all ? 'git add -A && ' : ''}git commit -q -m ${shq(msg)}`, cwd);
      if (r.code !== 0 && /tell me who you are|empty ident|auto-detect email/i.test(r.output || '')) {
        const ok = await dialog(root, {
          title: 'Git doesn\u2019t know who you are yet', icon: 'info',
          message: 'Every commit records an author. Set yours in the terminal:\n\ngit config --global user.name "Your Name"\ngit config --global user.email "you@example.com"\n\nor continue with a placeholder identity.',
          buttons: [{ label: 'Use a Placeholder Identity', value: true, primary: true }, { label: 'Cancel', value: false, cancel: true }],
        });
        if (ok) {
          await vmExec(vm, 'git config --global user.name "Student" && git config --global user.email "student@example.com"', cwd);
          r = await vmExec(vm, `git commit -q -m ${shq(msg)}`, cwd);
        } else r = null;
      }
      if (r && r.code !== 0) notify(`Git: commit failed.\n${String(r.output || '').trim()}`, 'error');
      else if (r) { scmMsg.value = ''; autoGrow(); }
      await refreshGit(true);
    } finally { scmCommit.disabled = false; }
  }
  async function initRepo() {
    const r = await vmExec(vm, 'git init', folder);
    if (r.code !== 0) notify('Git: init failed.\n' + String(r.output || '').trim(), 'error');
    git.root = null;
    await refreshGit(true);
  }
  function autoGrow() { scmMsg.style.height = 'auto'; scmMsg.style.height = Math.min(scmMsg.scrollHeight, 120) + 'px'; }
  scmMsg.addEventListener('input', () => { scmMsg.classList.remove('invalid'); autoGrow(); });
  scmMsg.addEventListener('keydown', e => { if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); } });
  scmCommit.addEventListener('click', () => commit());

  // ---------------------------------------------------------------- diff
  async function gitShow(spec) {
    const tmp = `/tmp/.qos-show-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const r = await vmExec(vm, `git show ${shq(spec)} > ${tmp} 2>/dev/null`, git.root);
    try { return r.code === 0 ? await vm.readText(tmp) : ''; } catch (e) { return ''; } finally { vm.remove(tmp).catch(() => {}); }
  }
  async function diffSides(it, staged) {
    if (staged) return [it.st === 'A' || git.unborn ? '' : await gitShow(`HEAD:${it.from || it.rel}`), it.st === 'D' ? '' : await gitShow(`:${it.rel}`)];
    const left = it.untracked ? '' : await gitShow(`:${it.rel}`);
    const right = it.st === 'D' ? '' : await vm.readText(it.path).catch(() => '');
    return [left, right];
  }
  async function openDiff(it, staged) {
    if (!monaco) { openFile(it.path, { preview: false }); return; }
    const key = `diff:${staged ? 'i' : 'w'}:${it.path}`;
    let t = findTab(key);
    const [l, r] = await diffSides(it, staged);
    if (disposed) return;
    if (!t) {
      const lang = langOf(it.path);
      t = { kind: 'diff', path: it.path, title: basename(it.path), staged, item: it, preview: true,
        orig: monaco.editor.createModel(l, lang), mod: monaco.editor.createModel(r, lang) };
      const prev = tabs.find(x => x.preview && !isDirty(x));
      if (prev) { const i = tabs.indexOf(prev); disposeTab(prev); tabs.splice(i, 1, t); }
      else tabs.push(t);
    } else {
      t.item = it;
      if (t.orig.getValue() !== l) t.orig.setValue(l);
      if (t.mod.getValue() !== r) t.mod.setValue(r);
    }
    activate(t);
  }
  function showDiff(t) {
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(diffEl, {
        theme: THEME, automaticLayout: true, readOnly: true, originalEditable: false, fontFamily: EDITOR_FONT, fontSize: +opts.fontSize || 13,
        lineHeight: 19, minimap: { enabled: false }, scrollBeyondLastLine: false, renderOverviewRuler: false,
        useInlineViewWhenSpaceIsLimited: true, renderSideBySideInlineBreakpoint: 700, hideUnchangedRegions: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      });
    }
    diffEditor.setModel({ original: t.orig, modified: t.mod });
  }
  const refreshOpenDiff = debounce(async () => {
    const t = active;
    if (!t || t.kind !== 'diff' || disposed) return;
    const list = t.staged ? git.staged : git.changes;
    const it = list.find(x => x.path === t.path);
    if (!it) return;
    const [l, r] = await diffSides(it, t.staged);
    if (disposed || !t.orig) return;
    if (t.orig.getValue() !== l) t.orig.setValue(l);
    if (t.mod.getValue() !== r) t.mod.setValue(r);
  }, 300);

  // ================================================================ integrated terminal
  let term = null, termP = null;
  function newTerminal() { killTerminal(); togglePanel(true); }
  function killTerminal() { if (term) { term.dispose(); term = null; termP = null; } }
  async function ensureTerminal(cwd) {
    if (term) return term;
    if (!termP) termP = createTerminal(termBody, {
      cwd: cwd || folder || '~', fontSize: 12, xtermTheme: { background: '#181818' },
      onExit: () => {},
    }, os).then(t => { term = t; return t; }).catch(e => { termP = null; notify('Could not start the terminal: ' + errMsg(e), 'error'); throw e; });
    return termP;
  }
  async function togglePanel(force, focus = true) {
    const show = force === undefined ? panel.hidden : force;
    panel.hidden = !show;
    sbTerm.classList.toggle('on', show);
    if (show) {
      if (!panelH) { panelH = Math.max(110, Math.round(main.clientHeight * 0.38)); panel.style.height = panelH + 'px'; }
      const t = await ensureTerminal().catch(() => null);
      if (t) { t.fit(); if (focus) t.focus(); }
    } else if (focus && editor && active && active.kind === 'file') editor.focus();
  }
  async function openTerminalAt(dir) {
    const fresh = !term && !termP;
    if (fresh) { await ensureTerminal(dir).catch(() => null); }
    await togglePanel(true);
    if (!fresh && term) term.run(`cd ${shq(dir)}`);
  }

  // ---------------------------------------------------------------- instance
  return {
    ready,
    get folder() { return folder; },
    openFile: (path, o) => ready.then(() => openFile(path, { preview: false, ...o })),
    save: () => save(active),
    focus() { if (editor && active && active.kind === 'file') editor.focus(); else treeEl.focus(); },
    toggleTerminal: f => togglePanel(f),
    dispose() {
      disposed = true;
      offs.forEach(f => f());
      if (gitWatchOff) gitWatchOff();
      for (const off of tree.watch.values()) off();
      for (const t of tabs) disposeTab(t);
      tabs.length = 0;
      try { editor && editor.dispose(); } catch (e) { /* ignore */ }
      try { diffEditor && diffEditor.dispose(); } catch (e) { /* ignore */ }
      killTerminal();
      if (wm) wm.dispose();
    },
  };
}
