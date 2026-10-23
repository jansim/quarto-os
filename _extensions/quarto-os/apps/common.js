// Quarto OS — helpers shared by the apps (terminal, explorer, vscode).
// Lazy-loaded together with the apps; never loaded on pages without apps.

export const CSS_URL = new URL('apps.css', import.meta.url).href;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

// ---------------------------------------------------------------- DOM

/** h('div.cls1.cls2', {attrs|on*}, ...children) */
export function h(sel, attrs, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Stop keyboard events from reaching reveal.js / page shortcuts. */
export function isolateKeys(root) {
  for (const t of ['keydown', 'keyup', 'keypress']) root.addEventListener(t, e => e.stopPropagation());
}

/** Load apps.css once (via the core's cached loader when available). */
export function loadAppCSS(os) { return loadCSS(os, CSS_URL); }
export function loadCSS(os, url) {
  if (os && typeof os.loadCSS === 'function') return Promise.resolve(os.loadCSS(url)).catch(() => {});
  if (document.querySelector(`link[data-qos-css="${url}"]`)) return Promise.resolve();
  return new Promise(res => {
    const l = h('link', { rel: 'stylesheet', href: url, 'data-qos-css': url });
    l.onload = l.onerror = () => res();
    document.head.appendChild(l);
  });
}

/** Create the app root inside win.body (fills it). */
export function mountRoot(win, cls) {
  const body = win.body;
  if (getComputedStyle(body).position === 'static') body.style.position = 'relative';
  const root = h('div.qos-app.' + cls);
  body.appendChild(root);
  isolateKeys(root);
  return root;
}

export function isDark(win, opts, os) {
  const t = opts && opts.theme;
  if (t) return t === 'dark';
  const el = win && win.el;
  if (el && (el.classList.contains('qos-dark') || el.classList.contains('qos-theme-dark') || el.dataset.theme === 'dark')) return true;
  return !!(os && os.config && os.config.theme === 'dark');
}

/** Subscribe to an emitter (vm / win), returning a disposer whatever the emitter's style. */
export function listen(em, ev, cb) {
  if (!em || typeof em.on !== 'function') return () => {};
  const r = em.on(ev, cb);
  return () => {
    try {
      if (typeof r === 'function') r();
      else if (typeof em.off === 'function') em.off(ev, cb);
      else if (typeof em.removeListener === 'function') em.removeListener(ev, cb);
    } catch (e) { /* ignore */ }
  };
}

export function errMsg(e) {
  if (!e) return 'Unknown error';
  return String(e.message || e).replace(/^Error:\s*/, '');
}

// ---------------------------------------------------------------- paths

export function normPath(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}
export function expandHome(p, home = '/home/user') {
  if (!p) return home;
  if (p === '~') return home;
  if (p.startsWith('~/')) return normPath(home + p.slice(1));
  if (!p.startsWith('/')) return normPath(home + '/' + p);
  return normPath(p);
}
export function tildify(p, home = '/home/user') {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}
export const join = (a, b) => normPath(a === '/' ? '/' + b : a + '/' + b);
export const dirname = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
export const basename = p => p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1);
export const extname = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
export const isInside = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
export const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function uniqueName(names, stem, ext = '') {
  const set = new Set(names);
  let n = stem + ext;
  for (let i = 2; set.has(n); i++) n = `${stem} ${i}${ext}`;
  return n;
}

// ---------------------------------------------------------------- formatting

export const mtimeMs = m => !m ? 0 : (m < 1e11 ? m * 1000 : m);

export function fmtDate(m) {
  const t = mtimeMs(m);
  if (!t) return '--';
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 864e5;
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Yesterday at ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString([], sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} at ${time}`;
}

export function fmtSize(n, type) {
  if (type === 'dir') return '--';
  if (n == null) return '--';
  if (n < 1000) return n === 1 ? '1 byte' : `${n} bytes`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
  return `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)} ${u[i]}`;
}

const KINDS = {
  py: 'Python Script', js: 'JavaScript', mjs: 'JavaScript', ts: 'TypeScript', json: 'JSON', md: 'Markdown',
  qmd: 'Quarto Document', txt: 'Plain Text', html: 'HTML', css: 'CSS', sh: 'Shell Script', c: 'C Source',
  h: 'C Header', yml: 'YAML', yaml: 'YAML', toml: 'TOML', r: 'R Script', ipynb: 'Jupyter Notebook',
  png: 'PNG Image', jpg: 'JPEG Image', jpeg: 'JPEG Image', gif: 'GIF Image', svg: 'SVG Image',
  pdf: 'PDF Document', zip: 'ZIP Archive', gz: 'Gzip Archive', tar: 'Tar Archive', csv: 'CSV', xml: 'XML',
  java: 'Java Source', rs: 'Rust Source', go: 'Go Source', rb: 'Ruby Script', lua: 'Lua Script', log: 'Log File',
};
export function kindOf(name, type) {
  if (type === 'dir') return 'Folder';
  if (type === 'link') return 'Alias';
  if (type === 'other') return 'Special File';
  if (name === 'Makefile') return 'Makefile';
  if (name.startsWith('.git')) return 'Git Config';
  const e = extname(name);
  return KINDS[e] || (e ? e.toUpperCase() + ' File' : 'Document');
}
export const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };

export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------- icons

const S = (vb, body, extra = '') =>
  `<svg viewBox="0 0 ${vb} ${vb}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${vb === 24 ? 1.5 : 1.2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const ICONS = {
  back: S(16, '<path d="M10 3 5 8l5 5"/>'),
  fwd: S(16, '<path d="m6 3 5 5-5 5"/>'),
  chevR: S(16, '<path d="m6 4 4 4-4 4"/>'),
  chevD: S(16, '<path d="m4 6 4 4 4-4"/>'),
  chevU: S(16, '<path d="m4 10 4-4 4 4"/>'),
  up: S(16, '<path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/>'),
  list: S(16, '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
  grid: S(16, '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>'),
  eye: S(16, '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'),
  eyeOff: S(16, '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" opacity=".55"/><circle cx="8" cy="8" r="2" opacity=".55"/><path d="m2.5 2.5 11 11"/>'),
  home: S(16, '<path d="M2.5 7.3 8 2.8l5.5 4.5M4 6.2V13h3v-3.2h2V13h3V6.2"/>'),
  computer: S(16, '<rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.2"/><path d="M5.8 13.6h4.4M8 11.2v2.4"/>'),
  folder: S(16, '<path d="M1.8 4.3c0-.5.4-.9.9-.9h3.2l1.5 1.5h5.9c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H2.7c-.5 0-.9-.4-.9-.9z"/>'),
  clock: S(16, '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  sidebar: S(16, '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="M6 2.8v10.4"/>'),
  close: S(16, '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>'),
  dot: S(16, '<circle cx="8" cy="8" r="3.6" fill="currentColor" stroke="none"/>'),
  check: S(16, '<path d="m3 8.5 3 3 7-7"/>'),
  plus: S(16, '<path d="M8 3v10M3 8h10"/>'),
  minus: S(16, '<path d="M3 8h10"/>'),
  discard: S(16, '<path d="M4.5 6.5h5.3a3 3 0 0 1 0 6H7M6.8 4 4.3 6.5 6.8 9"/>'),
  openFile: S(16, '<path d="M9 2.5H4.3a.8.8 0 0 0-.8.8v9.4c0 .4.4.8.8.8h7.4c.4 0 .8-.4.8-.8V6M9 2.5V6h3.5M9 2.5 12.5 6"/>'),
  newFile: S(16, '<path d="M8.5 2.5H4.3a.8.8 0 0 0-.8.8v9.4c0 .4.4.8.8.8H8M8.5 2.5V6H12M8.5 2.5 12 6v2M12 10.5v4M10 12.5h4"/>'),
  newFolder: S(16, '<path d="M8 13H2.7c-.5 0-.9-.4-.9-.9V4.3c0-.5.4-.9.9-.9h3.2l1.5 1.5h5.9c.5 0 .9.4.9.9V8M12 10v4.5M9.8 12.3h4.4"/>'),
  refresh: S(16, '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7"/>'),
  collapse: S(16, '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 8h5"/>'),
  branch: S(16, '<circle cx="5" cy="3.6" r="1.6"/><circle cx="5" cy="12.4" r="1.6"/><circle cx="11" cy="5.6" r="1.6"/><path d="M5 5.2v5.6M11 7.2c0 2.6-6 1.8-6 3.6"/>'),
  terminal: S(16, '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.3 6 2 2-2 2M8.3 10.3h3.4"/>'),
  trash: S(16, '<path d="M2.8 4.5h10.4M6.2 4.5V3h3.6v1.5M4.3 4.5l.6 8.6c0 .5.5.9 1 .9h4.2c.5 0 1-.4 1-.9l.6-8.6"/>'),
  more: S(16, '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>'),
  info: S(16, '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v4M8 4.9v.1"/>'),
  error: S(16, '<circle cx="8" cy="8" r="6.2"/><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4"/>'),
  warning: S(16, '<path d="M8 2.2 14.5 13.5h-13z"/><path d="M8 6.5v3.4M8 11.6v.1"/>'),
  copy: S(16, '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5V3.3a.8.8 0 0 0-.8-.8H3.3a.8.8 0 0 0-.8.8v6.4c0 .4.4.8.8.8h2.2"/>'),
  files24: S(24, '<path d="M13.5 3.5H8.2c-.9 0-1.7.8-1.7 1.7v12.6c0 .9.8 1.7 1.7 1.7h9.6c.9 0 1.7-.8 1.7-1.7V9.5z"/><path d="M13.5 3.5v6h6"/><path d="M3.5 7.5v12.8c0 .9.7 1.7 1.7 1.7h9.3"/>'),
  scm24: S(24, '<circle cx="7" cy="5.5" r="2.2"/><circle cx="7" cy="18.5" r="2.2"/><circle cx="17" cy="8.5" r="2.2"/><path d="M7 7.7v8.6M17 10.7c0 4.3-10 2.9-10 5.6"/>'),
};

export function iconEl(name, cls = '') {
  const s = h('span.qa-ic' + (cls ? '.' + cls : ''));
  s.innerHTML = ICONS[name] || '';
  return s;
}

// ---------------------------------------------------------------- clipboard

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------- context menu

let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu(); openMenu = null; } }

/**
 * Show a context menu at viewport coords. items: [{label, icon, kbd, action, disabled} | '-'].
 * The menu lives in document.body (position: fixed) so it is never clipped by the window.
 */
export function showMenu(x, y, items, { dark = false, variant = 'mac' } = {}) {
  closeMenu();
  const menu = h('div.qos-menu' + (dark ? '.qos-menu-dark' : '') + '.qos-menu-' + variant, { role: 'menu' });
  const btns = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { if (menu.lastChild && !menu.lastChild.classList.contains('qos-menu-sep')) menu.append(h('div.qos-menu-sep')); continue; }
    const b = h('div.qos-menu-item' + (it.disabled ? '.disabled' : ''), { role: 'menuitem', tabindex: '-1' },
      h('span.qos-menu-label', { text: it.label }), it.kbd ? h('span.qos-menu-kbd', { text: it.kbd }) : null);
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (it.disabled) return;
      closeMenu();
      try { it.action && it.action(); } catch (err) { console.error(err); }
    });
    b.addEventListener('pointerenter', () => b.focus({ preventScroll: true }));
    btns.push(b);
    menu.append(b);
  }
  if (menu.lastChild && menu.lastChild.classList.contains('qos-menu-sep')) menu.lastChild.remove();
  // Inherit the page's fullscreen element if any so the menu stays visible.
  (document.fullscreenElement || document.body).appendChild(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, vw - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, (y + r.height > vh - 4) ? Math.max(4, y - r.height) : y) + 'px';
  const onDown = e => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const live = btns.filter(b => !b.classList.contains('disabled'));
    const i = live.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (live[i + 1] || live[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (live[i - 1] || live[live.length - 1])?.focus(); }
    else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); live[i].click(); }
    e.stopPropagation();
  };
  const onBlur = () => closeMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
  });
  menu.addEventListener('keydown', onKey);
  menu.addEventListener('contextmenu', e => e.preventDefault());
  menu.tabIndex = -1;
  menu.focus({ preventScroll: true });
  openMenu = () => {
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    menu.remove();
  };
  return menu;
}

// ---------------------------------------------------------------- dialogs (sheet inside the app root)

/**
 * Modal dialog rendered inside `root`. buttons: [{label, value, primary, danger}].
 * Resolves with the clicked button's value (Escape → the button with cancel:true, else null).
 */
export function dialog(root, { title, message, buttons = [{ label: 'OK', value: true, primary: true }], icon = 'warning' }) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const btnEls = buttons.map(b => h('button.qos-dlg-btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''),
      { type: 'button', onclick: () => done(b.value) }, b.label));
    const box = h('div.qos-dlg', { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
      h('div.qos-dlg-icon.qos-dlg-' + icon, { html: ICONS[icon] || '' }),
      h('div.qos-dlg-title', { text: title || '' }),
      message ? h('div.qos-dlg-msg', { text: message }) : null,
      h('div.qos-dlg-btns', null, btnEls));
    const ov = h('div.qos-dlg-overlay', null, box);
    ov.addEventListener('pointerdown', e => { if (e.target === ov) { e.preventDefault(); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); } });
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); const c = buttons.find(b => b.cancel); done(c ? c.value : null); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); const p = buttons.find(b => b.primary); done(p ? p.value : null); }
      e.stopPropagation();
    });
    root.appendChild(ov);
    (btnEls[buttons.findIndex(b => b.primary)] || btnEls[0] || box).focus({ preventScroll: true });
    function done(v) {
      ov.remove();
      if (prevFocus && prevFocus.focus && root.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      resolve(v);
    }
  });
}

/** Open another app near the current window (same desktop if any). */
export function openApp(os, win, app, opts) {
  const o = { ...opts };
  const desk = win && win.el && win.el.closest('.qos-desktop');
  if (desk && desk.id && !o.target) o.target = desk.id;
  if (win && win.id) o.opener = win.id;
  return os.open(app, o);
}

/** Debounce helper. */
export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Observe element size; calls cb when it changes to a non-zero size. Returns disposer. */
export function onResize(el, cb) {
  let last = '';
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth, hh = el.clientHeight;
    const k = w + 'x' + hh;
    if (k === last) return;
    last = k;
    if (w && hh) cb(w, hh);
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/** Shared per-directory watch manager on top of vm.watch (ref-counted). */
export function watchManager(vm) {
  const map = new Map();
  return {
    watch(dir, cb) {
      let w = map.get(dir);
      if (!w) {
        w = { cbs: new Set(), off: null };
        map.set(dir, w);
        try {
          const r = vm.watch(dir, entries => { for (const f of [...w.cbs]) { try { f(entries); } catch (e) { console.error(e); } } });
          w.off = typeof r === 'function' ? r : (r && typeof r.then === 'function' ? () => r.then(u => typeof u === 'function' && u()) : null);
        } catch (e) { console.warn('[quarto-os] watch failed', dir, e); }
      }
      w.cbs.add(cb);
      return () => {
        w.cbs.delete(cb);
        if (!w.cbs.size) { map.delete(dir); try { w.off && w.off(); } catch (e) { /* ignore */ } }
      };
    },
    dispose() { for (const w of map.values()) { try { w.off && w.off(); } catch (e) { /* ignore */ } } map.clear(); },
  };
}
