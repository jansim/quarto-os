/*! Quarto OS core: macOS-style windows, desktops, launchers and a lazy app loader. MIT */
(function () {
'use strict';
if (window.QuartoOS) return;
const W = window, D = document, NAV = navigator;
const cur = D.currentScript;
const baseUrl = cur && cur.src ? cur.src.replace(/[?#].*$/, '').replace(/[^/]*$/, '') : '';

// == helpers
const $$ = (s, r) => Array.from((r || D).querySelectorAll(s));
const h = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const btn = (cls, html) => { const b = h('button', cls, html); b.type = 'button'; return b; };
const px = v => v == null || v === '' ? '' : /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? String(v).trim() + 'px' : String(v);
const yes = v => v === true || v === 'true' || v === 'yes' || v === '1';
const opt = el => { try { return JSON.parse(el.getAttribute('data-qos-opts') || '{}'); } catch (e) { return {}; } };
const esc = s => String(s).replace(/[&<>"]/g, c => '&#' + c.charCodeAt(0) + ';');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reduced = () => W.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const anim = (el, kf, ms) => !reduced() && el.animate ? el.animate(kf, { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {}) : Promise.resolve();
const Reveal = () => W.Reveal && W.Reveal.getScale ? W.Reveal : null;
const slideOf = el => Reveal() && el && el.closest ? el.closest('.reveal .slides section') : null;
const inView = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
const scrollTo = (el, block) => el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block });
const svgUrl = svg => 'data:image/svg+xml,' + encodeURIComponent(svg);
const icon = app => { const i = h('img', 'qos-icon'); i.alt = ''; i.draggable = false; i.src = svgUrl((apps[app] || apps.content).icon); return i; };
const warn = m => console.warn('[quarto-os] ' + m);

// == icons
const lg = (id, a, b) => `<linearGradient id="${id}" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const sq = (defs, art) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${defs}</defs><rect x="4" y="4" width="56" height="56" rx="13" fill="url(#b)"/><rect x="4.5" y="4.5" width="55" height="55" rx="12.5" fill="none" stroke="#fff" stroke-opacity=".22"/>${art}</svg>`;
const ICONS = {
  terminal: sq(lg('b', '#5b5b63', '#1d1d21'), '<rect x="9" y="11" width="46" height="40" rx="5" fill="#111114"/><path d="M16 23l8 6.5-8 6.5M28 39h12" fill="none" stroke="#f2f2f2" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  vscode: sq(lg('b', '#47b4ff', '#0b63c9'), '<g fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 21L12 32l11 11M41 21l11 11-11 11"/><path d="M36 17l-8 30" stroke-opacity=".7"/></g>'),
  explorer: sq(lg('b', '#f6f9fe', '#d3e3f6') + lg('f', '#7cc4ff', '#2e8ef0'), '<path d="M12 21a3 3 0 0 1 3-3h10l4 4h20a3 3 0 0 1 3 3v19H12z" fill="#1f73d6"/><path d="M12 27a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="url(#f)"/><path d="M12.5 28.5h39" stroke="#fff" stroke-opacity=".45"/>'),
  browser: sq(lg('b', '#fff', '#e1e4ea') + lg('g', '#62d2ff', '#1769e0'), '<circle cx="32" cy="32" r="20" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2"><ellipse cx="32" cy="32" rx="8.5" ry="20"/><path d="M12 32h40M15.5 21.5h33M15.5 42.5h33M32 12v40"/></g>'),
  content: sq(lg('b', '#ffd86b', '#f29b1d'), '<path d="M20 13h17l9 9v29a2 2 0 0 1-2 2H20a2 2 0 0 1-2-2V15a2 2 0 0 1 2-2z" fill="#fff"/><path d="M37 13v9h9" fill="#e9e9ee"/><path d="M23 30h17M23 36h17M23 42h11" stroke="#b9bcc4" stroke-width="2.4" stroke-linecap="round"/>')
};
const light = (k, label, d) => `<button type="button" class="qos-light qos-${k}" aria-label="${label}" title="${label}"><svg viewBox="0 0 12 12"><path d="${d}"/></svg></button>`;
const LIGHTS = '<div class="qos-lights">' + light('close', 'Close', 'M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8') +
  light('min', 'Minimize', 'M2.8 6h6.4') + light('max', 'Zoom', 'M3.2 4.4v4.4h4.4zM8.8 7.6V3.2H4.4z') + '</div>';

// == app registry
const apps = {
  terminal: { title: 'Terminal', icon: ICONS.terminal, module: 'apps/terminal.js', vm: true, size: [640, 380] },
  vscode: { title: 'Code', icon: ICONS.vscode, module: 'apps/vscode.js', vm: true, size: [900, 560] },
  explorer: { title: 'Files', icon: ICONS.explorer, module: 'apps/explorer.js', vm: true, size: [680, 420] },
  browser: { title: 'Browser', icon: ICONS.browser, vm: false, size: [820, 540], mount: mountBrowser },
  content: { title: 'Window', icon: ICONS.content, vm: false, size: [480, 320], mount: mountContent }
};

let config = {}, io = null, overlay = null, focused = null;
let zTop = 20, uid = 0, seq = 0;
const windows = [], desktops = [];
const alive = w => !!w && w.state !== 'closed' && windows.includes(w);
const recent = list => list.filter(w => w.seq).sort((a, b) => b.seq - a.seq)[0] || null;

// == Win
class Win {
  constructor(el, opts, host) {
    this.opts = opts = Object.assign({}, opts);
    this.app = opts.app || 'content';
    this.def = apps[this.app] || { title: this.app, icon: ICONS.content, size: [560, 360] };
    this.el = el;
    this.id = el.id || (el.id = 'qos-win-' + (++uid));
    this.l = {};
    this.instance = null;
    this.state = 'normal';
    this.theme = opts.theme || config.theme || 'light';
    el.qosWin = this;
    el.classList.add('qos-window', 'qos-ready', 'qos-app-' + this.app.replace(/[^\w-]/g, ''));
    if (this.theme === 'dark' || this.theme === 'auto') el.classList.add('qos-' + this.theme);
    let body = el.querySelector(':scope > .qos-body');
    if (!body) { body = h('div', 'qos-body'); while (el.firstChild) body.appendChild(el.firstChild); }
    const bar = h('div', 'qos-titlebar', LIGHTS + '<div class="qos-title"></div>');
    el.replaceChildren(bar, body);
    el.setAttribute('role', 'group');
    this.body = body; this.bar = bar; this.titleEl = bar.lastChild;
    if (this.app === 'content') classify(this);
    this.setTitle(opts.title != null ? opts.title : this.autoTitle || (this.app === 'content' ? '' : this.def.title));
    this.ready = new Promise(r => { this._ready = r; });
    this.place(host);
    this.wire();
    windows.push(this);
    if (this.desk && opts.state === 'minimized') this.minimize(true);
    else if (this.desk && opts.state === 'maximized') this.maximize();
  }

  // host: {type: inline|desktop|slide|overlay|anchor, el, desk}
  place(host) {
    const el = this.el, o = this.opts, sz = this.def.size, s = el.style;
    this.host = host;
    this.desk = host.desk || null;
    this.floating = host.type !== 'inline';
    el.classList.add(this.floating ? 'qos-floating' : 'qos-inline');
    if (!this.floating) {
      s.width = px(o.width) || (this.app === 'content' ? '' : '100%');
      s.height = px(o.height) || (this.app === 'content' ? '' : sz[1] + 'px');
      // centre windows with a width, but fill grid / flex cells
      if (o.width) el.classList.add('qos-sized');
      if (/grid|flex/.test(getComputedStyle(el.parentNode).display)) el.classList.add('qos-cell');
      return;
    }
    if (el.parentNode !== host.el) host.el.appendChild(el);
    const box = this.box(), t = host.type;
    s.width = px(o.width) || Math.min(sz[0], Math.max(240, box.w - 24)) + 'px';
    s.height = px(o.height) || (this.app === 'content' ? '' : Math.min(sz[1], Math.max(140, box.h - 60)) + 'px');
    let x = o.x, y = o.y;
    if (x == null || y == null) {
      // cascade from the front-most window (like macOS)
      const ww = el.offsetWidth, wh = el.offsetHeight;
      const prev = windows.filter(v => v.floating && v.host.el === host.el && v.state === 'normal').sort((a, b) => b.el.style.zIndex - a.el.style.zIndex)[0];
      let cx = 0, cy = 0;
      if (t === 'anchor') { /* at the anchor */ }
      else if (prev) { cx = prev.el.offsetLeft + 26; cy = prev.el.offsetTop + 26; }
      else if (t === 'desktop') { cx = 40; cy = 24; }
      else { cx = (box.w - ww) / 2; cy = (box.h - wh) / 2 - 40; }
      if (t !== 'anchor' && (cx + ww > box.w - 8 || cy + wh > box.h - 8)) {
        host.wrap = ((host.wrap || 0) + 1) % 6;
        cx = (t === 'desktop' ? 16 : (box.w - ww) / 2 - 60) + host.wrap * 30; cy = 12 + host.wrap * 12;
      }
      if (x == null) x = Math.round(Math.max(0, cx));
      if (y == null) y = Math.round(Math.max(t === 'anchor' ? 0 : 8, cy));
    }
    s.left = px(x); s.top = px(y);
    s.zIndex = ++zTop;
    this.fit();
  }

  // keep floating windows inside their container (shrink if needed; grow back later)
  fit() {
    const el = this.el, s = el.style, b = this.box();
    if (!this.floating || this.host.type === 'anchor' || this.state === 'maximized' || this.fs || !el.offsetWidth || !this.host.el.clientWidth) return;
    const k = this.want || (this.want = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, sw: s.width, sh: s.height });
    s.width = k.w > b.w ? b.w + 'px' : k.sw;
    s.height = k.h > b.h ? b.h + 'px' : k.sh;
    s.left = clamp(k.x, 0, Math.max(0, b.w - el.offsetWidth)) + 'px';
    s.top = clamp(k.y, 0, Math.max(0, b.h - el.offsetHeight)) + 'px';
  }

  box() {
    const R = Reveal(), e = this.host.el;
    if (this.host.type === 'slide' && R) { const s = R.getComputedSlideSize(); return { w: s.width, h: s.height }; }
    if (this.host.type === 'overlay') return { w: innerWidth, h: innerHeight };
    return { w: e.clientWidth || (e.parentNode && e.parentNode.clientWidth) || 800, h: e.clientHeight || 600 };
  }

  // pointer deltas are divided by the reveal.js scale
  scale() { return !this.fs && Reveal() && this.el.closest('.reveal .slides') ? Reveal().getScale() || 1 : 1; }

  wire() {
    const el = this.el, bar = this.bar;
    bar.addEventListener('click', e => {
      const b = e.target.closest('.qos-light');
      if (!b) return;
      e.stopPropagation();
      const k = b.classList;
      if (k.contains('qos-close')) this.close(); else if (k.contains('qos-min')) this.minimize(); else this.maximize();
    });
    bar.addEventListener('dblclick', e => { if (!e.target.closest('.qos-light')) this.maximize(); });
    bar.addEventListener('pointerdown', e => this.drag(e));
    el.addEventListener('pointerdown', () => this.focus(true), true);
    // keep keys / wheel away from reveal.js and page shortcuts
    'keydown keyup wheel touchstart touchmove'.split(' ').forEach(t => el.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    (this.floating ? ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] : ['grip']).forEach(d => {
      const g = h('div', 'qos-rs qos-rs-' + d);
      g.addEventListener('pointerdown', e => this.resize(e, d === 'grip' ? 'se' : d));
      el.appendChild(g);
    });
    if (W.ResizeObserver) (this.ro = new ResizeObserver(() => this.kick())).observe(this.body);
    if (io && !this.near) io.observe(el); else this.near = true;
  }

  // mount when first visible near the viewport; emit 'resize' while visible
  kick() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (!this.isVisible()) return;
      if (!this.mounted && (this.near || slideOf(this.el))) this.mount();
      if (this.body.clientWidth && this.body.clientHeight) this.emit('resize');
    });
  }

  pointerLoop(e, move) {
    e.preventDefault();
    const t = e.currentTarget, s = this.scale(), x0 = e.clientX, y0 = e.clientY, k = this.el.classList;
    try { t.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    k.add('qos-busy');
    const mv = ev => move((ev.clientX - x0) / s, (ev.clientY - y0) / s);
    const up = () => { ['pointermove', 'pointerup', 'pointercancel'].forEach((n, i) => t.removeEventListener(n, i ? up : mv)); k.remove('qos-busy'); this.want = null; };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
  }

  drag(e) {
    if (e.button || e.target.closest('.qos-light') || !this.floating || this.state === 'maximized' || this.fs) return;
    const el = this.el, l0 = el.offsetLeft, t0 = el.offsetTop, box = this.box(), w = el.offsetWidth, free = this.host.type === 'anchor';
    this.pointerLoop(e, (dx, dy) => {
      el.style.left = (free ? l0 + dx : clamp(l0 + dx, 60 - w, box.w - 60)) + 'px';
      el.style.top = (free ? t0 + dy : clamp(t0 + dy, 0, box.h - 32)) + 'px';
    });
  }

  resize(e, d) {
    if (e.button || this.state !== 'normal' || this.fs) return;
    e.stopPropagation();
    this.focus(true);
    const el = this.el, s = el.style, x = el.offsetLeft, y = el.offsetTop, w = el.offsetWidth, hh = el.offsetHeight;
    const maxW = this.floating ? 1e5 : el.parentNode.clientWidth || 1e5;
    this.pointerLoop(e, (dx, dy) => {
      if (d.includes('e')) s.width = clamp(w + dx, 200, maxW) + 'px';
      if (d.includes('s')) s.height = Math.max(90, hh + dy) + 'px';
      if (d.includes('w')) { const nw = Math.max(200, w - dx); s.width = nw + 'px'; s.left = x + w - nw + 'px'; }
      if (d.includes('n')) { const nh = Math.max(90, hh - dy); s.height = nh + 'px'; s.top = Math.max(0, y + hh - nh) + 'px'; }
    });
  }

  on(ev, cb) { (this.l[ev] || (this.l[ev] = [])).push(cb); return () => { this.l[ev] = (this.l[ev] || []).filter(f => f !== cb); }; }
  emit(ev, a) { (this.l[ev] || []).slice().forEach(f => { try { f(a); } catch (err) { console.error('[quarto-os]', err); } }); }

  setTitle(t) {
    this.title = t == null ? '' : String(t);
    this.titleEl.textContent = this.titleEl.title = this.title;
    if (this.desk) this.desk.update();
  }

  isVisible() {
    if (this.state === 'closed' || this.state === 'minimized' || !this.el.isConnected) return false;
    const s = slideOf(this.el);
    return !(s && !s.classList.contains('present')) && !!this.body.offsetParent;
  }

  // front window of each container looks active
  front() {
    if (!this.floating) return;
    if (!this.fs) this.el.style.zIndex = ++zTop;
    windows.forEach(w => { if (w.floating && w.host.el === this.host.el) w.el.classList.toggle('qos-inactive', w !== this); });
  }

  focus(user) {
    if (this.state === 'closed') return;
    this.front();
    this.seq = ++seq;
    if (this.app === 'terminal') QOS.lastTerminal = this;
    if (focused !== this) {
      const prev = focused;
      focused = this;
      if (prev) { prev.el.classList.remove('qos-focused'); prev.emit('blur'); }
      this.el.classList.add('qos-focused');
      this.emit('focus');
    }
    if (this.desk) this.desk.update();
    if (!user && this.instance && this.instance.focus) { try { this.instance.focus(); } catch (e) { /* ignore */ } }
  }

  // activate the most recent remaining window of this container
  next() {
    if (focused === this) { focused = null; this.el.classList.remove('qos-focused'); this.emit('blur'); }
    const n = this.floating && recent(windows.filter(w => w !== this && w.host.el === this.host.el && w.state !== 'minimized' && w.state !== 'closed'));
    if (n) n.focus(true);
    if (this.desk) this.desk.update();
  }

  genie(tile, back) {
    const a = this.el.getBoundingClientRect(), b = tile.getBoundingClientRect();
    const far = { transform: `translate(${b.left + b.width / 2 - a.left - a.width / 2}px,${b.top + b.height / 2 - a.top - a.height / 2}px) scale(.08)`, opacity: 0.2 }, near = { transform: 'none' };
    return anim(this.el, back ? [far, near] : [near, far], 250);
  }

  minimize(instant) {
    if (this.state === 'closed') return;
    if (this.fs) this.exitFS();
    if (!this.desk) {
      // outside desktops: collapse to the title bar
      this.state = this.el.classList.toggle('qos-collapsed') ? 'collapsed' : 'normal';
      return this.kick();
    }
    if (this.state === 'minimized') return this.restore();
    this.prev = this.state;
    this.state = 'minimized';
    const tile = this.desk.minimized(this, true);
    const hide = () => this.el.classList.add('qos-hidden');
    if (instant || !tile) hide(); else this.genie(tile).then(hide);
    this.next();
  }

  restore() {
    if (this.closedBar) return this.reopen();
    if (this.state === 'minimized') {
      this.state = this.prev === 'maximized' ? 'maximized' : 'normal';
      this.el.classList.remove('qos-hidden');
      const tile = this.desk.tile(this);
      if (tile) { this.genie(tile, true); this.desk.minimized(this, false); }
    } else if (this.state === 'collapsed') {
      this.el.classList.remove('qos-collapsed');
      this.state = 'normal';
    }
    this.focus();
    this.kick();
  }

  // green button: fill the desktop, else fullscreen (toggles)
  maximize() {
    if (this.state === 'closed') return;
    if (this.state === 'minimized' || this.state === 'collapsed') this.restore();
    if (!this.desk) return this.fs ? this.exitFS() : this.enterFS();
    const on = this.state !== 'maximized', k = this.el.classList;
    this.state = on ? 'maximized' : 'normal';
    k.add('qos-anim');
    k.toggle('qos-max', on);
    setTimeout(() => { k.remove('qos-anim'); this.kick(); }, 260);
    this.focus();
  }

  enterFS() {
    const el = this.el;
    this.fs = true;
    el.classList.add('qos-fullscreen');
    // the top layer escapes transformed ancestors (reveal.js slides)
    if (el.showPopover) { try { el.popover = 'manual'; el.showPopover(); } catch (e) { /* ignore */ } }
    this._esc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.exitFS(); } };
    D.addEventListener('keydown', this._esc, true);
    D.documentElement.classList.add('qos-has-fullscreen');
    this.focus();
    anim(el, [{ transform: 'scale(.97)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], 180);
    this.kick();
  }

  exitFS() {
    const el = this.el;
    this.fs = false;
    if (el.hasAttribute('popover')) { try { el.hidePopover(); } catch (e) { /* ignore */ } el.removeAttribute('popover'); }
    el.classList.remove('qos-fullscreen');
    D.removeEventListener('keydown', this._esc, true);
    if (!windows.some(w => w.fs)) D.documentElement.classList.remove('qos-has-fullscreen');
    this.kick();
  }

  dispose() {
    if (this.instance && this.instance.dispose) { try { this.instance.dispose(); } catch (e) { console.error('[quarto-os]', e); } }
    this.emit('close');
    this.l = {};
    this.instance = null;
    this.seq = 0;
    if (QOS.lastTerminal === this) QOS.lastTerminal = recent(windows.filter(w => w !== this && w.app === 'terminal' && w.state !== 'closed'));
  }

  close() {
    if (this.state === 'closed') return;
    if (this.fs) this.exitFS();
    this.next();
    this.state = 'closed';
    if (!this.floating) {
      // inline: leave a "closed" bar so the document keeps its content
      if (this.app !== 'content') { this.dispose(); this.mounted = false; this.body.replaceChildren(); }
      const bar = this.closedBar = h('div', 'qos-closedbar');
      const b = btn('qos-reopen', 'Reopen');
      b.onclick = () => this.reopen();
      bar.append(icon(this.app), h('span', '', '<b>' + esc(this.title || this.def.title) + '</b> closed'), b);
      this.el.before(bar);
      this.el.classList.add('qos-hidden');
      return;
    }
    this.dispose();
    windows.splice(windows.indexOf(this), 1);
    if (this.ro) this.ro.disconnect();
    if (this.desk) { this.desk.minimized(this, false); this.desk.update(); }
    anim(this.el, [{ transform: 'none', opacity: 1 }, { transform: 'scale(.94)', opacity: 0 }], 160).then(() => this.el.remove());
  }

  reopen() {
    if (!this.closedBar) return;
    this.closedBar.remove();
    this.closedBar = null;
    this.el.classList.remove('qos-hidden', 'qos-collapsed');
    this.state = 'normal';
    if (!this.mounted) this.ready = new Promise(r => { this._ready = r; });
    anim(this.el, [{ transform: 'scale(.97)', opacity: 0 }, { transform: 'none', opacity: 1 }], 200);
    this.focus(true);
    this.kick();
  }

  mount() {
    if (this.mounted) return this.ready;
    this.mounted = true;
    const def = this.def, body = this.body, opts = this.opts;
    const done = inst => { this.instance = inst || {}; this._ready(this.instance); return this.instance; };
    const fail = err => this.fail(err);
    if (def.mount) { try { return Promise.resolve(def.mount(this, opts, QOS)).then(done, fail); } catch (err) { return fail(err); } }
    if (!def.module) return fail(new Error('Unknown app "' + this.app + '"'));
    body.classList.add('qos-app');
    const ph = h('div', 'qos-placeholder');
    ph.append(icon(this.app), h('div', '', 'Loading ' + esc(def.title) + '…'), h('div', 'qos-spinner'));
    body.appendChild(ph);
    const mo = new MutationObserver(rs => { if (rs.some(r => Array.from(r.addedNodes).some(n => n !== ph && n.nodeType === 1))) drop(); });
    const drop = () => { ph.remove(); mo.disconnect(); };
    return import(new URL(def.module, baseUrl || location.href).href).then(mod => {
      if (typeof mod.mount !== 'function') throw new Error(def.module + ' does not export mount()');
      mo.observe(body, { childList: true });
      return Promise.resolve(mod.mount(this, opts, QOS)).then(inst => { drop(); return done(inst); });
    }).catch(err => { drop(); return fail(err); });
  }

  fail(err) {
    console.error('[quarto-os] ' + this.app + ':', err);
    const box = h('div', 'qos-error');
    box.append(icon(this.app), h('div', 'qos-err-title', 'Couldn’t open ' + esc(this.def.title)), h('div', 'qos-err-msg', esc((err && err.message) || err)));
    this.body.appendChild(box);
    this._ready(null);
    return null;
  }
}

// content windows: media edge to edge, code flush, prose padded
function classify(win) {
  const b = win.body, kids = b.children, cl = b.classList;
  const media = b.querySelectorAll('img,video,iframe,svg,canvas,object');
  const txt = e => (e.textContent || '').replace(/\s+/g, '');
  cl.remove('qos-media', 'qos-code', 'qos-prose');
  if (media.length === 1 && txt(b) === $$('figcaption', b).map(txt).join('')) {
    cl.add('qos-media');
    const m = media[0], s = m.querySelector('source') || m;
    if (win.opts.fit) m.style.objectFit = win.opts.fit;
    const src = s.getAttribute('src') || s.getAttribute('data-src');
    if (src) win.autoTitle = decodeURIComponent(src.split(/[?#]/)[0].split('/').pop());
  } else if (kids.length === 1 && kids[0].matches('div.sourceCode, pre, .code-copy-outer-scaffold, .code-with-filename')) {
    cl.add('qos-code');
    const fn = b.querySelector('.code-with-filename-file');
    if (fn) { win.autoTitle = fn.textContent.trim(); fn.classList.add('qos-hidden'); }
  } else cl.add('qos-prose');
}

// == builtin apps
function mountContent(win, opts) {
  const c = opts.content;
  if (c != null) {
    if (typeof c === 'string') win.body.innerHTML = c; else win.body.appendChild(c);
    classify(win);
    if (!opts.title && win.autoTitle) win.setTitle(win.autoTitle);
  }
  return {};
}

function mountBrowser(win, opts) {
  const b = win.body;
  b.classList.add('qos-browser');
  const bar = h('form', 'qos-urlbar', '<button type="button" aria-label="Reload" title="Reload">↻</button>' +
    '<input type="text" spellcheck="false" aria-label="Address"><a target="_blank" rel="noopener" title="Open in new tab">↗</a>');
  const frame = h('iframe', 'qos-frame'), input = bar.querySelector('input'), link = bar.querySelector('a');
  frame.setAttribute('credentialless', ''); // lets cross-origin pages load on cross-origin isolated pages (Chromium)
  frame.setAttribute('allow', 'fullscreen; clipboard-write');
  b.append(bar, frame);
  const go = u => {
    u = String(u || '').trim() || 'about:blank';
    if (!/^[a-z][\w+.-]*:|^[/.]/i.test(u)) u = 'https://' + u;
    frame.src = link.href = u;
    input.value = u === 'about:blank' ? '' : u;
    if (!opts.title) { try { win.setTitle(new URL(u, location.href).host || 'Browser'); } catch (e) { win.setTitle(u); } }
  };
  bar.addEventListener('submit', e => { e.preventDefault(); go(input.value); });
  bar.firstChild.onclick = () => { const s = frame.src; frame.src = 'about:blank'; setTimeout(() => { frame.src = s; }, 30); };
  go(opts.url);
  return { navigate: go, focus() { input.focus(); } };
}

// == desktop
const LOGO = '<svg viewBox="0 0 16 16"><path d="M8 1.2c.5 3.4 2.4 5.3 5.8 5.8-3.4.5-5.3 2.4-5.8 5.8-.5-3.4-2.4-5.3-5.8-5.8C5.6 6.5 7.5 4.6 8 1.2z"/><circle cx="13" cy="13" r="1.6"/></svg>';
const STATUS = '<svg viewBox="0 0 20 14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2.6 5.4a10.5 10.5 0 0 1 14.8 0M5.6 8.4a6.2 6.2 0 0 1 8.8 0"/><circle cx="10" cy="11.6" r="1.5" fill="currentColor" stroke="none"/></svg>' +
  '<svg viewBox="0 0 26 14"><rect x=".7" y="1.7" width="21.6" height="10.6" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55"/><rect x="2.4" y="3.4" width="15" height="7.2" rx="1.6"/><path d="M23.6 5.2v3.6a2 2 0 0 0 0-3.6z" opacity=".55"/></svg>';

class Desktop {
  constructor(el) {
    const o = this.opts = opt(el);
    this.el = el;
    el.qosDesk = this;
    el.classList.add('qos-ready');
    el.style.height = px(o.height || '480px');
    if (o.width) el.style.width = px(o.width);
    // image paths are relative to the page
    if (o.wallpaper) el.style.setProperty('--qos-wallpaper', /gradient\(|^#|^rgb|^hsl|^var\(/.test(o.wallpaper) ? o.wallpaper : 'url("' + new URL(o.wallpaper, D.baseURI).href + '") center / cover no-repeat');
    if ((o.theme || config.theme) === 'dark') el.classList.add('qos-desk-dark');
    const kids = Array.from(el.children), extra = h('div', 'qos-desk-content');
    const screen = h('div', 'qos-screen');
    kids.forEach(k => { if (!k.classList.contains('qos-window')) extra.appendChild(k); });
    if (extra.firstChild) screen.appendChild(extra);
    if (o.menubar == null || yes(o.menubar)) {
      this.menubar = h('div', 'qos-menubar', '<span class="qos-mb-logo">' + LOGO + '</span><b class="qos-mb-app"></b>' +
        ['File', 'Edit', 'View', 'Window', 'Help'].map(m => '<span class="qos-mb-menu">' + m + '</span>').join('') +
        '<span class="qos-mb-right"><span class="qos-mb-status"></span>' + STATUS + '<span class="qos-mb-clock"></span></span>');
      el.appendChild(this.menubar);
    } else el.classList.add('qos-nomenubar');
    el.appendChild(screen);
    this.host = { type: 'desktop', el: screen, desk: this };
    if (W.ResizeObserver) new ResizeObserver(() => this.wins().forEach(w => w.fit())).observe(screen);
    this.dock();
    kids.forEach(k => { if (k.classList.contains('qos-window')) new Win(k, opt(k), this.host); });
    desktops.push(this);
    const ws = this.wins().filter(w => w.state !== 'minimized');
    if (ws.length) ws[ws.length - 1].front(); // the last window in source order is in front
    this.update();
    tick();
  }

  wins() { return windows.filter(w => w.desk === this && w.state !== 'closed'); }

  dock() {
    const list = (this.opts.dock == null ? 'terminal,vscode,explorer' : this.opts.dock).split(/[\s,]+/).filter(Boolean);
    if (!list.length) { this.el.classList.add('qos-nodock'); return; }
    const dock = this.dockEl = h('div', 'qos-dock'), box = h('div', 'qos-dock-apps');
    this.minBox = h('div', 'qos-dock-min');
    this.items = {};
    list.forEach(a => {
      const t = apps[a] ? apps[a].title : a, it = this.items[a] = btn('qos-dock-item');
      it.setAttribute('aria-label', 'Open ' + t);
      it.append(icon(a), h('span', 'qos-tip', esc(t)), h('span', 'qos-dot'));
      it.addEventListener('click', () => {
        anim(it.firstChild, [{ transform: 'none' }, { transform: 'translateY(-22%)' }, { transform: 'none' }], 420);
        open(a, { target: this.el });
      });
      box.appendChild(it);
    });
    dock.append(box, h('div', 'qos-dock-sep'), this.minBox);
    this.el.appendChild(dock);
    // magnification
    const items = () => $$('.qos-dock-item', dock);
    dock.addEventListener('pointermove', e => {
      if (reduced() || e.pointerType === 'touch') return;
      const s = Reveal() && dock.closest('.reveal .slides') ? Reveal().getScale() : 1;
      items().forEach(it => {
        const r = it.getBoundingClientRect(), k = Math.max(0, 1 - Math.abs(e.clientX - r.left - r.width / 2) / s / (it.offsetHeight * 2.6));
        it.style.setProperty('--qos-mag', (1 + 0.55 * (1 - Math.cos(k * Math.PI)) / 2).toFixed(3));
      });
    });
    dock.addEventListener('pointerleave', () => items().forEach(it => it.style.removeProperty('--qos-mag')));
  }

  tile(win) { return this.minBox ? this.minBox.querySelector('[data-win="' + win.id + '"]') : null; }

  // add / remove the dock tile of a minimized window
  minimized(win, add) {
    let t = this.tile(win);
    if (add && !t && this.minBox) {
      t = btn('qos-dock-item qos-dock-mini');
      t.dataset.win = win.id;
      t.setAttribute('aria-label', 'Restore ' + (win.title || win.def.title));
      t.append(icon(win.app), h('span', 'qos-tip', esc(win.title || win.def.title)));
      t.addEventListener('click', () => win.restore());
      this.minBox.appendChild(t);
    } else if (!add && t) t.remove();
    this.update();
    return t;
  }

  update() {
    const ws = this.wins(), f = focused && focused.desk === this && focused.state !== 'minimized' ? focused : null;
    Object.keys(this.items || {}).forEach(a => this.items[a].classList.toggle('qos-running', ws.some(w => w.app === a)));
    if (this.menubar) this.menubar.querySelector('.qos-mb-app').textContent = f && f.app !== 'content' ? f.def.title : this.opts.title || 'Desktop';
    if (this.dockEl) this.dockEl.classList.toggle('qos-has-min', this.minBox.children.length > 0);
  }
}

let clock = 0;
function tick() {
  const s = new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(/,/g, '');
  $$('.qos-mb-clock').forEach(c => { c.textContent = s; });
  if (!clock) clock = setInterval(tick, 15000);
}

// == open() and target resolution
function hostFor(target, origin) {
  if (target instanceof Win) { origin = target.el; target = null; }
  if (typeof target === 'string' && target) {
    const t = D.getElementById(target.replace(/^#/, ''));
    if (!t) warn('no element #' + target);
    target = t;
  }
  if (target && target.nodeType === 1) {
    if (target.qosDesk) return target.qosDesk.host;
    if (slideOf(target) === target) return { type: 'slide', el: target };
    origin = target;
  }
  if (origin) {
    const dk = origin.closest('.qos-desktop'), w = origin.closest('.qos-window');
    if (dk && dk.qosDesk) return dk.qosDesk.host;
    if (w && w.qosWin && w.qosWin.host.type === 'overlay') return w.qosWin.host;
    const s = slideOf(origin);
    if (s) {
      // floating in that slide (or in the slide's only desktop)
      const here = desktops.filter(d => slideOf(d.el) === s);
      return here.length === 1 ? here[0].host : { type: 'slide', el: s };
    }
  }
  if (desktops.length === 1) return desktops[0].host;
  if (!overlay || !overlay.isConnected) D.body.appendChild(overlay = h('div', 'qos-overlay'));
  return { type: 'overlay', el: overlay };
}

function open(app, opts) {
  opts = Object.assign({}, opts, { app: app || (opts && opts.app) || 'content' });
  const host = hostFor(opts.target, opts.origin);
  delete opts.target; delete opts.origin;
  const el = h('div');
  if (opts.id) { el.id = opts.id; delete opts.id; }
  host.el.appendChild(el);
  const win = new Win(el, opts, host);
  anim(el, [{ transform: 'scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }], 200);
  win.focus(true);
  if (host.desk && !inView(host.desk.el)) scrollTo(host.desk.el, 'nearest');
  return Promise.resolve(win.mount()).then(() => { win.focus(); return win; });
}

// == run snippets
function run(text, target, origin) {
  text = String(text == null ? '' : text).replace(/\s+$/, '');
  origin = origin || (Reveal() && Reveal().getCurrentSlide && Reveal().getCurrentSlide());
  let win = null, host;
  if (target) {
    const t = D.getElementById(String(target).replace(/^#/, ''));
    if (t && t.qosWin) win = t.qosWin;
    else if (t && t.qosDesk) host = t;
    else warn('run target not found: ' + target);
  }
  if (!win && !host) {
    // last focused terminal (in a slide: of that slide), else the only one
    const terms = windows.filter(w => w.app === 'terminal' && w.state !== 'closed');
    const s = slideOf(origin), lt = alive(QOS.lastTerminal) ? QOS.lastTerminal : recent(terms);
    if (s) { const here = terms.filter(w => slideOf(w.el) === s); win = here.includes(lt) ? lt : here[here.length - 1]; }
    else win = lt || (terms.length === 1 ? terms[0] : null);
  }
  const go = w => {
    if (w.state === 'minimized' || w.state === 'collapsed' || w.closedBar) w.restore();
    if (!w.floating && !inView(w.el)) scrollTo(w.el, 'center');
    w.focus();
    w.mount();
    return w.ready.then(inst => {
      if (inst && inst.run) inst.run(text); else warn('window ' + w.id + ' cannot run commands');
      return w;
    });
  };
  return win ? go(win) : open('terminal', { target: host, origin }).then(go);
}

function setupRun(el) {
  if (el.matches('code')) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.title = 'Run in terminal'; return; }
  const pre = el.matches('pre') ? el : el.querySelector('pre');
  if (!pre) return;
  const wrap = pre.closest('.code-copy-outer-scaffold') || pre.closest('div.sourceCode') || pre.parentNode;
  const b = btn('qos-runbtn', 'Run <svg viewBox="0 0 10 10"><path d="M2.5 1.5v7l6-3.5z"/></svg>');
  b.title = 'Run in terminal';
  wrap.classList.add('qos-run-wrap');
  wrap.appendChild(b);
}

const runTarget = el => { const t = el.closest('[data-qos-target]'); return t && t.getAttribute('data-qos-target'); };
const flash = el => { el.classList.remove('qos-flash'); void el.offsetWidth; el.classList.add('qos-flash'); };

// == loaders & VM
const loaded = {};
let amd = 0, amdSaved;
function load(url, make) {
  url = new URL(url, baseUrl || location.href).href;
  return loaded[url] || (loaded[url] = new Promise((res, rej) => {
    const e = make(url);
    e.onload = () => res(e);
    e.onerror = () => { delete loaded[url]; rej(new Error('Failed to load ' + url)); };
    D.head.appendChild(e);
  }));
}
// hides window.define while loading (UMD vs Monaco's AMD loader)
const loadScript = url => load(url, u => {
  const s = D.createElement('script');
  s.src = u; s.async = true;
  if (!amd++) { amdSaved = W.define; W.define = undefined; }
  s.addEventListener('load', fin); s.addEventListener('error', fin);
  return s;
});
function fin() { if (!--amd && W.define === undefined && amdSaved !== undefined) W.define = amdSaved; }
const loadCSS = url => load(url, u => { const l = D.createElement('link'); l.rel = 'stylesheet'; l.href = u; return l; });

let vmP = null;
function vm() {
  if (vmP) return vmP;
  vmP = import(baseUrl + 'vm/vm.js').then(m => m.createVM(config.vm || {}, { baseUrl }));
  vmP.then(v => {
    const st = s => $$('.qos-mb-status').forEach(e => { e.textContent = s; e.classList.toggle('qos-on', !!s); });
    if (v && v.on) v.on('status', s => st(String(s || '')));
    if (v && v.ready && v.ready.then) v.ready.then(() => setTimeout(() => st(''), 1200), () => st('VM error'));
  }, () => { vmP = null; });
  return vmP;
}

// == cross-origin isolation (GitHub Pages)
function coi() {
  const K = 'qos-coi-reload', SW = NAV.serviceWorker;
  let ss = null;
  try { ss = W.sessionStorage; } catch (e) { /* ignore */ }
  if (W.crossOriginIsolated) { if (ss) ss.removeItem(K); return; }
  if (!config.usesVM || config.coi === false || !SW || !W.isSecureContext) return;
  const reload = () => {
    if (ss && ss.getItem(K)) return warn('page is still not cross-origin isolated; the Linux VM may not start.');
    if (ss) ss.setItem(K, '1');
    location.reload();
  };
  // COEP credentialless (Chromium, Firefox) keeps cross-origin images without CORP working; Safari: require-corp
  const cred = !!(W.chrome || W.netscape || NAV.userAgentData || /Firefox\//.test(NAV.userAgent));
  SW.register(new URL((config.coiUrl || 'coi-serviceworker.js') + (cred ? '?coep=credentialless' : ''), location.href).href).then(reg => {
    if (reg.active && !SW.controller) reload();
    else if (!reg.active) SW.addEventListener('controllerchange', reload, { once: true });
  }, err => warn('could not register coi-serviceworker.js: ' + err));
}

// == init
// the Lua filter can't see shortcodes, so check the DOM for VM apps too
function pageUsesVM() {
  const vmApp = a => !!(apps[a] && apps[a].vm);
  return !!D.querySelector('.qos-run') ||
    $$('.qos-window').some(e => vmApp(opt(e).app)) ||
    $$('.qos-launch').some(e => vmApp(opt(e).app || 'terminal')) ||
    $$('.qos-desktop').some(e => (opt(e).dock == null ? 'terminal' : opt(e).dock).split(/[\s,]+/).some(vmApp));
}

function initWindow(el) {
  if (el.qosWin) return;
  const o = opt(el);
  let host = { type: 'inline', el: el.parentNode };
  if (yes(o.float) || o.x != null || o.y != null) {
    const s = slideOf(el);
    if (s) host = { type: 'slide', el: s };
    else {
      // floats over the document near where it was written
      const a = h('div', 'qos-anchor');
      el.before(a);
      host = { type: 'anchor', el: a };
    }
  }
  new Win(el, o, host);
}

const refresh = () => windows.forEach(w => w.kick());

function init() {
  const c = D.getElementById('quarto-os-config');
  try { config = QOS.config = c ? JSON.parse(c.textContent || '{}') : {}; } catch (e) { console.error('[quarto-os] bad config', e); }
  if (!config.usesVM && pageUsesVM()) config.usesVM = true;
  coi();
  if (W.IntersectionObserver) {
    io = new IntersectionObserver(es => es.forEach(e => {
      const w = e.target.qosWin;
      if (w && e.isIntersecting) { w.near = true; io.unobserve(e.target); w.kick(); }
    }), { rootMargin: '300px' });
  }
  $$('.qos-desktop').forEach(el => new Desktop(el));
  $$('.qos-window').forEach(initWindow);
  $$('.qos-run').forEach(setupRun);
  $$('.qos-launch').forEach(l => l.style.setProperty('--qos-launch-icon', 'url("' + QOS.icon(opt(l).app || 'terminal') + '")'));

  D.addEventListener('click', e => {
    const l = e.target.closest('.qos-launch'), rb = e.target.closest('.qos-runbtn'), rc = e.target.closest('code.qos-run');
    if (l) {
      e.preventDefault();
      const o = opt(l);
      open(o.app || 'terminal', Object.assign(o, { origin: l })).catch(err => console.error('[quarto-os]', err));
    } else if (rb) {
      const pre = rb.parentNode.querySelector('pre');
      flash(rb.parentNode);
      run(pre.textContent, runTarget(pre), rb);
    } else if (rc && !rc.closest('pre')) { flash(rc); run(rc.textContent, runTarget(rc), rc); }
  });
  D.addEventListener('keydown', e => {
    const rc = e.target.closest && e.target.closest('code.qos-run');
    if (rc && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); run(rc.textContent, runTarget(rc), rc); }
  });

  const R = Reveal();
  if (R && R.on) {
    ['ready', 'slidechanged', 'resize', 'overviewhidden'].forEach(ev => R.on(ev, () => setTimeout(refresh, 30)));
    R.on('slidechanged', () => windows.forEach(w => { if (w.fs && !w.isVisible()) w.exitFS(); }));
  }
  W.addEventListener('load', refresh);
  W.addEventListener('resize', () => windows.forEach(w => { if (w.host.type === 'overlay') w.fit(); }));
  if (config.vm && config.vm.autoboot) vm().catch(err => console.error('[quarto-os] VM', err));
  D.dispatchEvent(new CustomEvent('quarto-os:ready', { detail: QOS }));
}

const QOS = W.QuartoOS = {
  version: '0.1.0',
  config, baseUrl, apps, windows, desktops,
  lastTerminal: null,
  open, vm, loadScript, loadCSS,
  run: (text, target) => run(text, target),
  icon: app => svgUrl((apps[app] || apps.content).icon),
  Win
};

if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();
