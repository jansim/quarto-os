// Quarto OS — Finder-like file explorer for the shared Linux VM.

import {
  h, ICONS, iconEl, loadAppCSS, mountRoot, isDark, listen, errMsg, expandHome, tildify, join, dirname,
  basename, extname, isInside, uniqueName, fmtDate, fmtSize, kindOf, mtimeMs, IMAGE_EXT, looksBinary,
  showMenu, dialog, copyText, openApp, onResize, watchManager, isMac,
} from './common.js';

// ------------------------------------------------------------------ icons (Finder-ish, flat)
const FOLDER = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M5 15.5A4.5 4.5 0 0 1 9.5 11h13.2c1.2 0 2.3.5 3.2 1.3l3.3 3.2h25.3a4.5 4.5 0 0 1 4.5 4.5v28.5a4.5 4.5 0 0 1-4.5 4.5h-45A4.5 4.5 0 0 1 5 48.5z" fill="#3e9bec"/><path d="M5 23.5A4.5 4.5 0 0 1 9.5 19h45a4.5 4.5 0 0 1 4.5 4.5v25a4.5 4.5 0 0 1-4.5 4.5h-45A4.5 4.5 0 0 1 5 48.5z" fill="#74bdf7"/><path d="M5 23.5A4.5 4.5 0 0 1 9.5 19h45a4.5 4.5 0 0 1 4.5 4.5v.8H5z" fill="#a9d7fc"/></svg>';
function docIcon(name, big) {
  const ext = extname(name);
  const isImg = !!IMAGE_EXT[ext];
  const label = big && ext && ext.length <= 4 && !isImg ? `<text x="32" y="50.5" text-anchor="middle" font-size="8.5" font-weight="700" fill="#8e8e93" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" letter-spacing=".3">${ext.toUpperCase()}</text>` : '';
  const lines = isImg
    ? '<rect x="19" y="24" width="26" height="19" rx="2" fill="#dbeeff"/><circle cx="26" cy="30" r="3" fill="#f7c948"/><path d="m19 43 9-9 6 6 4-3 7 6z" fill="#57b35f"/>'
    : `<g stroke="#d4d4d8" stroke-width="2" stroke-linecap="round"><path d="M20 24h18M20 29h24M20 34h21${label ? '' : 'M20 39h24M20 44h16'}"/></g>`;
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M15.5 5.5h23l13 13v38a3 3 0 0 1-3 3h-33a3 3 0 0 1-3-3v-48a3 3 0 0 1 3-3z" fill="#fff" stroke="#c4c4c9" stroke-width="1.2"/><path d="M38.5 5.5v10a3 3 0 0 0 3 3h10" fill="#ebebee" stroke="#c4c4c9" stroke-width="1.2" stroke-linejoin="round"/>${lines}${label}</svg>`;
}
const LINK_BADGE = '<svg class="qx-badge" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="#fff" stroke="#bbb"/><path d="M5 11 11 5M6.5 5H11v4.5" fill="none" stroke="#333" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const entryIcon = (e, big) => (e.type === 'dir' ? FOLDER : docIcon(e.name, big)) + (e.type === 'link' ? LINK_BADGE : '');

const COLS = [
  { key: 'name', label: 'Name' },
  { key: 'mtime', label: 'Date Modified' },
  { key: 'size', label: 'Size' },
  { key: 'kind', label: 'Kind' },
];

export async function mount(win, opts = {}, os = window.QuartoOS) {
  await loadAppCSS(os);
  const root = mountRoot(win, 'qos-explorer');
  const dark = isDark(win, opts, os);
  if (dark) root.classList.add('qos-dark');
  const explicitTitle = !!opts.title;

  // ---------------------------------------------------------------- state
  let vm = null, wm = null, home = '/home/user', disposed = false;
  let cwd = null, entries = [], hist = [], hi = -1;
  let view = opts.view === 'icons' ? 'icons' : 'list';
  let showHidden = !(opts.hidden === false || opts.hidden === 'false');
  let sortKey = 'name', sortDir = 1, selected = null, renaming = null, pending = null;
  let unwatch = null, favs = [];
  const offs = [];

  // ---------------------------------------------------------------- DOM
  const tbBtn = (icon, title, onclick, cls = '') => h('button.qx-tb-btn' + cls, { type: 'button', title, 'aria-label': title, onclick, html: ICONS[icon] });
  const bBack = tbBtn('back', 'Back', () => goHist(-1));
  const bFwd = tbBtn('fwd', 'Forward', () => goHist(1));
  const bUp = tbBtn('up', 'Enclosing folder', () => cwd && cwd !== '/' && go(dirname(cwd)));
  const bSide = tbBtn('sidebar', 'Show/hide sidebar', () => toggleSidebar());
  const crumbs = h('div.qx-crumbs');
  const bList = tbBtn('list', 'as List', () => setView('list'));
  const bIcons = tbBtn('grid', 'as Icons', () => setView('icons'));
  const bHidden = tbBtn('eye', 'Show hidden files', () => { showHidden = !showHidden; render(); });
  const toolbar = h('div.qx-toolbar', null,
    bSide, h('div.qx-nav', null, bBack, bFwd), bUp, crumbs,
    h('div.qx-seg', { role: 'group' }, bList, bIcons), bHidden);
  const content = h('div.qx-content', { tabindex: '0' });
  const status = h('div.qx-status');
  const sidebar = h('div.qx-sidebar');
  const main = h('div.qx-main', null, toolbar, content, status);
  root.append(sidebar, main);

  const offSize = onResize(root, w => {
    crumbs.scrollLeft = crumbs.scrollWidth;
    const narrow = w < 540;
    if (narrow !== root.classList.contains('qx-narrow')) {
      root.classList.toggle('qx-narrow', narrow);
      root.classList.remove('qx-side-open');
    }
  });
  offs.push(offSize);
  function toggleSidebar() {
    if (root.classList.contains('qx-narrow')) root.classList.toggle('qx-side-open');
    else root.classList.toggle('qx-side-hidden');
  }
  main.addEventListener('pointerdown', () => root.classList.remove('qx-side-open'));

  // ---------------------------------------------------------------- loading state
  const loading = h('div.qx-empty', null, h('div.qx-spinner'), h('div.qx-loading-text', { text: 'Starting Linux…' }));
  content.append(loading);
  status.textContent = '';

  async function init() {
    try {
      vm = await os.vm();
      offs.push(listen(vm, 'status', s => { if (!cwd && s) loading.lastChild.textContent = String(s); }));
      await vm.ready;
    } catch (e) {
      if (!disposed) content.replaceChildren(h('div.qx-empty.qx-error', null, iconEl('error', 'qx-err-ic'),
        h('div', { text: 'The Linux VM could not be started.' }), h('div.qx-err-msg', { text: errMsg(e) })));
      return;
    }
    if (disposed) return;
    home = vm.home || home;
    wm = watchManager(vm);
    renderSidebar();
    vm.ls(home).then(setFavs).catch(() => {});
    offs.push(wm.watch(home, setFavs));
    const start = expandHome(opts.path || '~', home);
    if (!(await go(start))) {
      await go(home);
      if (start !== home) fail(`The folder “${tildify(start, home)}” can’t be opened.`, 'Showing your home folder instead.');
    }
  }

  // ---------------------------------------------------------------- sidebar
  function sideItem(icon, label, path, cls = '') {
    const it = h('div.qx-side-item' + cls, { 'data-path': path, title: tildify(path, home) },
      h('span.qx-side-ic', { html: ICONS[icon] }), h('span.qx-side-label', { text: label }));
    it.addEventListener('click', () => { go(path); root.classList.remove('qx-side-open'); });
    it.addEventListener('contextmenu', e => { e.preventDefault(); itemMenu(e, { name: basename(path), type: 'dir' }, path); });
    return it;
  }
  function renderSidebar() {
    sidebar.replaceChildren(
      h('div.qx-side-head', { text: 'Favorites' }),
      sideItem('home', basename(home), home),
      ...favs.map(n => sideItem('folder', n, join(home, n))),
      h('div.qx-side-head', { text: 'Locations' }),
      sideItem('computer', 'quarto-os', '/'),
      sideItem('folder', 'tmp', '/tmp'),
    );
    markSidebar();
  }
  function markSidebar() {
    for (const it of sidebar.querySelectorAll('.qx-side-item')) it.classList.toggle('active', it.dataset.path === cwd);
  }
  function setFavs(list) {
    const next = list.filter(e => e.type === 'dir' && !e.name.startsWith('.')).map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, 8);
    if (next.join('/') !== favs.join('/')) { favs = next; renderSidebar(); }
  }
  // ---------------------------------------------------------------- navigation
  async function go(path, push = true) {
    if (!vm || disposed) return false;
    path = expandHome(path, home);
    let list;
    try { list = await vm.ls(path); } catch (e) {
      if (disposed) return false;
      if (!cwd) return false;
      await dialog(root, { title: `The folder “${basename(path)}” can’t be opened.`, message: errMsg(e), icon: 'error', buttons: [{ label: 'OK', value: true, primary: true, cancel: true }] });
      return false;
    }
    if (disposed) return false;
    const prev = cwd;
    if (push && path !== cwd) { hist = hist.slice(0, hi + 1); hist.push(path); hi = hist.length - 1; }
    cwd = path; entries = list;
    selected = prev && isInside(prev, path) && prev !== path ? prev.slice(path === '/' ? 1 : path.length + 1).split('/')[0] : null;
    renaming = null; pending = null;
    if (unwatch) unwatch();
    const p = path;
    unwatch = wm.watch(path, (l, err) => { if (p !== cwd) return; if (err && cwd !== '/') go(dirname(cwd)); else if (!err) setEntries(l); });
    if (!explicitTitle) win.setTitle(path === '/' ? 'quarto-os' : basename(path));
    render();
    content.scrollTop = 0;
    if (selected) scrollToSel();
    return true;
  }
  function goHist(d) {
    const i = hi + d;
    if (i < 0 || i >= hist.length) return;
    hi = i;
    go(hist[i], false);
  }
  async function reload() {
    if (!cwd) return;
    try { setEntries(await vm.ls(cwd)); } catch (e) { /* folder vanished */ go(dirname(cwd), true); }
  }
  function setEntries(list) {
    if (renaming) { pending = list; return; }
    entries = list;
    render();
  }

  // ---------------------------------------------------------------- rendering
  const visible = () => {
    const list = entries.filter(e => showHidden || !e.name.startsWith('.'));
    const kind = e => kindOf(e.name, e.type);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      mtime: (a, b) => mtimeMs(a.mtime) - mtimeMs(b.mtime),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      kind: (a, b) => kind(a).localeCompare(kind(b)),
    }[sortKey];
    return list.sort((a, b) => ((b.type === 'dir') - (a.type === 'dir')) || (cmp(a, b) * sortDir) || a.name.localeCompare(b.name));
  };

  function render() {
    if (!cwd) return;
    const st = content.scrollTop;
    const list = visible();
    if (selected && !list.some(e => e.name === selected)) selected = null;
    root.classList.toggle('qx-view-icons', view === 'icons');
    bList.classList.toggle('on', view === 'list');
    bIcons.classList.toggle('on', view === 'icons');
    bHidden.classList.toggle('on', showHidden);
    bHidden.innerHTML = showHidden ? ICONS.eye : ICONS.eyeOff;
    bHidden.title = showHidden ? 'Hide hidden files' : 'Show hidden files';
    bBack.disabled = hi <= 0; bFwd.disabled = hi >= hist.length - 1; bUp.disabled = cwd === '/';
    renderCrumbs();
    markSidebar();

    let body;
    if (view === 'list') {
      const head = h('div.qx-head', null, COLS.map(c => h('div.qx-hc.qx-c-' + c.key + (sortKey === c.key ? '.sorted' : ''),
        { onclick: () => { if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = 1; } render(); } },
        h('span', { text: c.label }), sortKey === c.key ? h('span.qx-sort', { html: sortDir > 0 ? ICONS.chevU : ICONS.chevD }) : null)));
      const rows = list.map((e, i) => h('div.qx-row' + (i % 2 ? '.odd' : '') + (e.name === selected ? '.sel' : '') + (e.name.startsWith('.') ? '.hidden-file' : ''),
        { 'data-name': e.name, role: 'row' },
        h('div.qx-c-name', null, h('span.qx-ic', { html: entryIcon(e, false) }), h('span.qx-name', { text: e.name })),
        h('div.qx-c-mtime', { text: fmtDate(e.mtime) }),
        h('div.qx-c-size', { text: fmtSize(e.size, e.type) }),
        h('div.qx-c-kind', { text: kindOf(e.name, e.type) })));
      // stripes continue below the last row, like Finder
      body = h('div.qx-list', null, head, h('div.qx-rows', null, rows, h('div.qx-filler', { 'data-odd': list.length % 2 ? '1' : '0' })));
    } else {
      body = h('div.qx-grid', null, list.map(e => h('div.qx-tile' + (e.name === selected ? '.sel' : '') + (e.name.startsWith('.') ? '.hidden-file' : ''),
        { 'data-name': e.name, title: e.name },
        h('div.qx-tile-ic', { html: entryIcon(e, true) }), h('div.qx-tile-name', null, h('span', { text: e.name })))));
    }
    if (!list.length) body.append(h('div.qx-empty-note', { text: entries.length ? 'Only hidden items' : 'Folder is empty' }));
    content.replaceChildren(body);
    content.scrollTop = st;
    updateStatus(list);
  }

  function updateStatus(list = visible()) {
    const n = list.length, hidden = entries.length - n;
    status.textContent = selected ? `1 of ${n} selected` : `${n} item${n === 1 ? '' : 's'}${hidden ? `, ${hidden} hidden` : ''}`;
  }

  function renderCrumbs() {
    const parts = cwd === '/' ? [] : cwd.split('/').filter(Boolean);
    const segs = [h('span.qx-crumb', { 'data-path': '/', title: '/' }, h('span.qx-crumb-ic', { html: ICONS.computer }), h('span', { text: 'quarto-os' }))];
    let acc = '';
    for (const p of parts) {
      acc += '/' + p;
      segs.push(h('span.qx-crumb-sep', { html: ICONS.chevR }));
      const isHome = acc === home;
      segs.push(h('span.qx-crumb', { 'data-path': acc, title: acc }, isHome ? h('span.qx-crumb-ic', { html: ICONS.home }) : h('span.qx-crumb-ic', { html: FOLDER }), h('span', { text: p })));
    }
    crumbs.replaceChildren(...segs);
    crumbs.lastChild.classList.add('last');
    crumbs.scrollLeft = crumbs.scrollWidth;
  }
  crumbs.addEventListener('click', e => { const c = e.target.closest('.qx-crumb'); if (c && c.dataset.path !== cwd) go(c.dataset.path); });

  function setView(v) { view = v; render(); scrollToSel(); }

  function scrollToSel() {
    const el = selected && content.querySelector(`[data-name="${CSS.escape(selected)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function select(name) {
    selected = name;
    for (const el of content.querySelectorAll('.qx-row, .qx-tile')) el.classList.toggle('sel', el.dataset.name === name);
    updateStatus();
    scrollToSel();
  }
  const entryOf = name => entries.find(e => e.name === name);
  const itemEl = t => t.closest && t.closest('.qx-row, .qx-tile');

  // ---------------------------------------------------------------- mouse
  content.addEventListener('pointerdown', e => {
    if (renaming && !e.target.closest('input')) finishRename(true);
    const it = itemEl(e.target);
    if (e.button === 2 && it) { select(it.dataset.name); return; }
    if (e.button !== 0) return;
    if (it) select(it.dataset.name);
    else if (!e.target.closest('.qx-head')) select(null);
  });
  content.addEventListener('dblclick', e => {
    const it = itemEl(e.target);
    if (it && !renaming) openEntry(entryOf(it.dataset.name));
  });
  content.addEventListener('contextmenu', e => {
    e.preventDefault();
    const it = itemEl(e.target);
    if (it) { const en = entryOf(it.dataset.name); if (en) itemMenu(e, en, join(cwd, en.name)); }
    else bgMenu(e);
  });

  // ---------------------------------------------------------------- keyboard
  let typeBuf = '', typeT = 0;
  content.addEventListener('keydown', e => {
    if (renaming || e.target !== content) return;
    const list = visible();
    const idx = list.findIndex(x => x.name === selected);
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const move = d => { const n = list[Math.max(0, Math.min(list.length - 1, (idx < 0 ? (d > 0 ? -1 : list.length) : idx) + d))]; if (n) select(n.name); };
    const gridCols = () => { const t = content.querySelectorAll('.qx-tile'); if (!t.length) return 1; const top = t[0].offsetTop; let c = 0; for (const x of t) { if (x.offsetTop !== top) break; c++; } return c || 1; };
    let handled = true;
    if ((e.key === 'ArrowUp' && (mod || e.altKey)) || (e.key === 'Backspace' && !mod)) { if (cwd !== '/') go(dirname(cwd)); }
    else if (e.key === 'ArrowDown' && (mod || e.altKey)) { const en = entryOf(selected); if (en) openEntry(en); }
    else if ((e.key === 'ArrowLeft' && e.altKey) || (mod && e.key === '[')) goHist(-1);
    else if ((e.key === 'ArrowRight' && e.altKey) || (mod && e.key === ']')) goHist(1);
    else if (e.key === 'ArrowDown') move(view === 'icons' ? gridCols() : 1);
    else if (e.key === 'ArrowUp') move(view === 'icons' ? -gridCols() : -1);
    else if (e.key === 'ArrowRight' && view === 'icons') move(1);
    else if (e.key === 'ArrowLeft' && view === 'icons') move(-1);
    else if (e.key === 'Home') { if (list[0]) select(list[0].name); }
    else if (e.key === 'End') { if (list.length) select(list[list.length - 1].name); }
    else if (e.key === 'Enter') { const en = entryOf(selected); if (en) openEntry(en); }
    else if (e.key === 'F2') { if (selected) startRename(selected); }
    else if (e.key === ' ') { const en = entryOf(selected); if (en) quickLook(en); }
    else if (e.key === 'Delete' || (e.key === 'Backspace' && mod)) { const en = entryOf(selected); if (en) del(en); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') newItem('dir');
    else if (mod && e.shiftKey && e.key === '.') { showHidden = !showHidden; render(); }
    else if (e.key.length === 1 && !mod && !e.altKey && e.key !== ' ') {
      clearTimeout(typeT); typeBuf += e.key.toLowerCase(); typeT = setTimeout(() => { typeBuf = ''; }, 700);
      const m = list.find(x => x.name.toLowerCase().startsWith(typeBuf)) || list.find(x => x.name.toLowerCase().replace(/^\./, '').startsWith(typeBuf));
      if (m) select(m.name);
    } else handled = false;
    if (handled) e.preventDefault();
  });

  // ---------------------------------------------------------------- actions
  async function openEntry(en) {
    if (!en) return;
    const path = join(cwd, en.name);
    let type = en.type;
    if (type === 'link') { try { const s = await vm.stat(path); type = s ? s.type : 'file'; } catch (e) { type = 'file'; } }
    if (type === 'dir') go(path);
    else if (opts.preview === true || opts.preview === 'true') quickLook(en);
    else openInCode(path, false);
  }

  function sameContainer(w) { return w.el && win.el && w.el.parentElement === win.el.parentElement; }
  function openInCode(path, isDir) {
    const wins = (os.windows || []).filter(w => w !== win && w.app === 'vscode' && w.instance && sameContainer(w));
    if (!isDir) {
      const w = wins.find(x => x.instance.folder && isInside(path, x.instance.folder) && typeof x.instance.openFile === 'function');
      if (w) { w.instance.openFile(path); try { w.focus(); } catch (e) { /* ignore */ } return; }
      return openApp(os, win, 'vscode', { folder: dirname(path), open: basename(path) });
    }
    const w = wins.find(x => x.instance.folder === path);
    if (w) { try { w.focus(); } catch (e) { /* ignore */ } return; }
    return openApp(os, win, 'vscode', { folder: path });
  }
  const openInTerminal = dir => openApp(os, win, 'terminal', { cwd: dir });

  async function newItem(type) {
    const names = entries.map(e => e.name);
    const name = type === 'dir' ? uniqueName(names, 'untitled folder') : uniqueName(names, 'untitled', '.txt');
    const path = join(cwd, name);
    try {
      if (type === 'dir') await vm.mkdir(path); else await vm.writeFile(path, '');
    } catch (e) { return fail(`Couldn’t create “${name}”.`, e); }
    try { entries = await vm.ls(cwd); } catch (e) { /* ignore */ }
    if (!showHidden && name.startsWith('.')) showHidden = true;
    render();
    select(name);
    startRename(name);
  }

  function startRename(name) {
    const el = content.querySelector(`[data-name="${CSS.escape(name)}"]`);
    if (!el) return;
    const label = el.querySelector('.qx-name, .qx-tile-name span');
    const input = h('input.qx-rename', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
    input.value = name;
    label.replaceWith(input);
    renaming = { name, input };
    input.focus();
    const dot = name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 && entryOf(name)?.type !== 'dir' ? dot : name.length);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
    });
    input.addEventListener('blur', () => finishRename(true));
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('dblclick', e => e.stopPropagation());
  }
  async function finishRename(commit) {
    if (!renaming) return;
    const { name, input } = renaming;
    const to = input.value.trim();
    renaming = null;
    const flush = () => { if (pending) { entries = pending; pending = null; } render(); content.focus({ preventScroll: true }); };
    if (!commit || !to || to === name) { flush(); select(name); return; }
    if (to.includes('/') || to === '.' || to === '..') { flush(); return fail(`The name “${to}” can’t be used.`, 'Names can’t contain “/”.'); }
    if (entries.some(e => e.name === to)) { flush(); return fail(`The name “${to}” is already taken.`, 'Please choose a different name.'); }
    try { await vm.rename(join(cwd, name), join(cwd, to)); } catch (e) { flush(); return fail(`Couldn’t rename “${name}”.`, e); }
    pending = null;
    try { entries = await vm.ls(cwd); } catch (e) { /* ignore */ }
    render(); select(to); content.focus({ preventScroll: true });
  }

  async function del(en) {
    const ok = await dialog(root, {
      title: `Are you sure you want to delete “${en.name}”?`,
      message: en.type === 'dir' ? 'This folder and everything in it will be deleted immediately. You can’t undo this action.' : 'This item will be deleted immediately. You can’t undo this action.',
      buttons: [{ label: 'Delete', value: true, danger: true, primary: true }, { label: 'Cancel', value: false, cancel: true }],
    });
    if (!ok) { content.focus({ preventScroll: true }); return; }
    try { await vm.remove(join(cwd, en.name)); } catch (e) { return fail(`Couldn’t delete “${en.name}”.`, e); }
    if (selected === en.name) selected = null;
    await reload();
    content.focus({ preventScroll: true });
  }

  function fail(title, e) {
    return dialog(root, { title, message: typeof e === 'string' ? e : errMsg(e), icon: 'error', buttons: [{ label: 'OK', value: true, primary: true, cancel: true }] });
  }

  // ---------------------------------------------------------------- menus
  function itemMenu(ev, en, path) {
    const isDir = en.type === 'dir';
    const dir = isDir ? path : dirname(path);
    showMenu(ev.clientX, ev.clientY, [
      { label: 'Open', action: () => isDir ? go(path) : openEntry(en) },
      !isDir && { label: 'Quick Look', kbd: 'Space', action: () => quickLook(en) },
      '-',
      { label: isDir ? 'Open Folder in VS Code' : 'Open in VS Code', action: () => openInCode(path, isDir) },
      { label: isDir ? 'New Terminal at Folder' : 'Open in Terminal', action: () => openInTerminal(dir) },
      '-',
      dirname(path) === cwd && { label: 'Rename', kbd: 'F2', action: () => startRename(en.name) },
      dirname(path) === cwd && { label: 'Delete', kbd: isMac ? '⌘⌫' : 'Del', action: () => del(en) },
      '-',
      { label: 'Copy Path', action: () => copyText(path) },
    ], { dark });
  }
  function bgMenu(ev) {
    showMenu(ev.clientX, ev.clientY, [
      { label: 'New File', action: () => newItem('file') },
      { label: 'New Folder', kbd: isMac ? '⇧⌘N' : 'Ctrl+Shift+N', action: () => newItem('dir') },
      '-',
      { label: 'Open in Terminal', action: () => openInTerminal(cwd) },
      { label: 'Open Folder in VS Code', action: () => openInCode(cwd, true) },
      '-',
      { label: showHidden ? 'Hide Hidden Files' : 'Show Hidden Files', kbd: isMac ? '⇧⌘.' : 'Ctrl+Shift+.', action: () => { showHidden = !showHidden; render(); } },
      { label: view === 'list' ? 'View as Icons' : 'View as List', action: () => setView(view === 'list' ? 'icons' : 'list') },
      { label: 'Refresh', action: reload },
      '-',
      { label: 'Copy Path', action: () => copyText(cwd) },
    ], { dark });
  }

  // ---------------------------------------------------------------- quick look
  let ql = null;
  async function quickLook(en) {
    if (ql) { const same = ql.name === en.name; closeQL(); if (same) return; }
    if (en.type === 'dir') return;
    const path = join(cwd, en.name);
    const bodyEl = h('div.qx-ql-body', null, h('div.qx-spinner'));
    const box = h('div.qx-ql', { tabindex: '-1' },
      h('div.qx-ql-bar', null,
        h('button.qx-ql-btn', { type: 'button', title: 'Close', html: ICONS.close, onclick: () => closeQL() }),
        h('div.qx-ql-title', { text: en.name }),
        h('button.qx-ql-open', { type: 'button', onclick: () => { closeQL(); openInCode(path, false); } }, 'Open with VS Code')),
      bodyEl);
    const ov = h('div.qx-ql-overlay', { onclick: e => { if (e.target === ov) closeQL(); } }, box);
    box.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQL(); } });
    root.appendChild(ov);
    ql = { name: en.name, ov, url: null };
    box.focus({ preventScroll: true });
    const me = ql;
    try {
      const bytes = await vm.readFile(path);
      if (ql !== me) return;
      const mime = IMAGE_EXT[extname(en.name)];
      if (mime) {
        me.url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        bodyEl.replaceChildren(h('img.qx-ql-img', { src: me.url, alt: en.name }));
        bodyEl.classList.add('img');
      } else if (looksBinary(bytes)) {
        bodyEl.replaceChildren(h('div.qx-ql-info', null, h('div.qx-ql-big', { html: docIcon(en.name, true) }), h('div', { text: en.name }), h('div.qx-ql-sub', { text: `${kindOf(en.name, en.type)} · ${fmtSize(bytes.length)}` })));
      } else {
        const max = 200000;
        const text = new TextDecoder().decode(bytes.length > max ? bytes.subarray(0, max) : bytes);
        bodyEl.replaceChildren(h('div.qx-ql-text', { text: text + (bytes.length > max ? '\n…' : '') || ' ' }));
      }
    } catch (e) {
      if (ql === me) bodyEl.replaceChildren(h('div.qx-ql-info', null, h('div', { text: errMsg(e) })));
    }
  }
  function closeQL() {
    if (!ql) return;
    if (ql.url) URL.revokeObjectURL(ql.url);
    ql.ov.remove();
    ql = null;
    content.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- start
  renderSidebar();
  const ready = init();
  return {
    ready,
    get path() { return cwd; },
    navigate: p => go(p),
    focus() { content.focus({ preventScroll: true }); },
    dispose() {
      disposed = true;
      if (unwatch) unwatch();
      if (renaming) renaming = null;
      offs.forEach(f => f());
      if (wm) wm.dispose();
      closeQL();
    },
  };
}
