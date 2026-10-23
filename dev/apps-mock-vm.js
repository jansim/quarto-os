// In-memory mock of the Quarto OS VM API (see dev/SPEC.md "VM API").
// Used by dev/apps-test.html to develop the apps without CheerpX.
// Includes a toy line-based shell for sessions and a toy `git`.

const enc = new TextEncoder(), dec = new TextDecoder();
const HOME = '/home/user';
const now = () => Date.now();

class Emitter {
  constructor() { this.l = {}; }
  on(ev, cb) { (this.l[ev] ||= new Set()).add(cb); return () => this.off(ev, cb); }
  off(ev, cb) { this.l[ev]?.delete(cb); }
  emit(ev, ...a) { for (const cb of [...(this.l[ev] || [])]) { try { cb(...a); } catch (e) { console.error(e); } } }
}

// ------------------------------------------------------------------ filesystem
const D = (children = {}) => ({ type: 'dir', children: new Map(Object.entries(children)), mtime: now() - 864e5 * 3 });
const F = (text, age = 3600e3) => ({ type: 'file', data: enc.encode(text), mtime: now() - age });

function norm(p, cwd = HOME) {
  if (p === '~' || p === '') p = HOME;
  else if (p.startsWith('~/')) p = HOME + p.slice(1);
  else if (!p.startsWith('/')) p = cwd + '/' + p;
  const out = [];
  for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
  return '/' + out.join('/');
}
const parentOf = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const nameOf = p => p.slice(p.lastIndexOf('/') + 1);

class FS {
  constructor() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" rx="10" fill="#4f9cf5"/><circle cx="35" cy="40" r="18" fill="#fff"/><text x="62" y="47" font-family="sans-serif" font-size="20" fill="#fff">OS</text></svg>';
    this.root = D({
      bin: D({ bash: F('\x7fELF\0\0\0binary'), ls: F('\x7fELF\0\0binary') }),
      etc: D({ hostname: F('quarto-os\n'), 'os-release': F('PRETTY_NAME="Debian GNU/Linux 10 (buster)"\n') }),
      tmp: D({}),
      usr: D({ bin: D({}), share: D({}) }),
      home: D({
        user: D({
          '.bashrc': F('# ~/.bashrc\nexport PS1="\\u@\\h:\\w\\$ "\nalias ll="ls -la"\n', 864e5 * 10),
          '.profile': F('# ~/.profile\n[ -f ~/.bashrc ] && . ~/.bashrc\n', 864e5 * 10),
          '.gitconfig': F('[user]\n\tname = Student\n\temail = student@example.com\n[init]\n\tdefaultBranch = main\n', 864e5 * 9),
          Desktop: D({}),
          Documents: D({ 'notes.md': F('# Notes\n\n- learn git\n- learn the shell\n', 864e5), 'logo.svg': F(svg, 864e5 * 2) }),
          repo: D({
            'README.md': F('# Demo repo\n\nA tiny project to learn **git**.\n\n```bash\npython3 hello.py\n```\n'),
            'hello.py': F('def greet(name):\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("world"))\n'),
            '.gitignore': F('__pycache__/\n*.log\n'),
            src: D({ 'app.js': F('export function add(a, b) {\n  return a + b;\n}\n\nconsole.log(add(2, 3));\n'), 'style.css': F('body {\n  font-family: system-ui;\n  color: #333;\n}\n') }),
            'debug.log': F('ignored log line\n'),
          }),
          'todo.txt': F('1. open the terminal\n2. cd repo\n3. git status\n', 7200e3),
        }),
      }),
    });
    this.root.children.get('home').children.get('user').children.get('repo').mtime = now() - 60e3;
  }
  get(p) {
    if (p === '/') return this.root;
    let n = this.root;
    for (const s of p.split('/').filter(Boolean)) { if (!n || n.type !== 'dir') return null; n = n.children.get(s); }
    return n || null;
  }
  dirOf(p) { const d = this.get(parentOf(p)); if (!d || d.type !== 'dir') throw new Error(`${parentOf(p)}: No such file or directory`); return d; }
  touchDir(p) { const d = this.get(p); if (d) d.mtime = now(); }
  ls(p) {
    const n = this.get(p);
    if (!n) throw new Error(`ls: cannot access '${p}': No such file or directory`);
    if (n.type !== 'dir') throw new Error(`ls: '${p}': Not a directory`);
    return [...n.children].map(([name, c]) => ({ name, type: c.type, size: c.type === 'dir' ? 4096 : c.data.length, mtime: Math.floor(c.mtime / 1000) }));
  }
  read(p) { const n = this.get(p); if (!n) throw new Error(`${p}: No such file or directory`); if (n.type === 'dir') throw new Error(`${p}: Is a directory`); return n.data; }
  write(p, data, append = false) {
    const d = this.dirOf(p), name = nameOf(p);
    let n = d.children.get(name);
    if (n && n.type === 'dir') throw new Error(`${p}: Is a directory`);
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    if (!n) { n = F(''); d.children.set(name, n); d.mtime = now(); }
    n.data = append ? new Uint8Array([...n.data, ...bytes]) : new Uint8Array(bytes);
    n.mtime = now();
  }
  mkdir(p, parents = false) {
    if (parents) { let cur = ''; for (const s of p.split('/').filter(Boolean)) { cur += '/' + s; if (!this.get(cur)) this.mkdir(cur); } return; }
    const d = this.dirOf(p);
    if (d.children.has(nameOf(p))) throw new Error(`mkdir: cannot create directory '${p}': File exists`);
    d.children.set(nameOf(p), D({})); d.children.get(nameOf(p)).mtime = now(); d.mtime = now();
  }
  remove(p) {
    if (p === '/' || p === HOME) throw new Error(`rm: refusing to remove '${p}'`);
    const d = this.dirOf(p);
    if (!d.children.has(nameOf(p))) throw new Error(`rm: cannot remove '${p}': No such file or directory`);
    d.children.delete(nameOf(p)); d.mtime = now();
  }
  rename(a, b) {
    const da = this.dirOf(a), n = da.children.get(nameOf(a));
    if (!n) throw new Error(`mv: cannot stat '${a}': No such file or directory`);
    const tb = this.get(b);
    if (tb && tb.type === 'dir') b = b + '/' + nameOf(a);
    const db = this.dirOf(b);
    da.children.delete(nameOf(a)); db.children.set(nameOf(b), n);
    da.mtime = db.mtime = now();
  }
  walkFiles(root, skip = () => false) {
    const out = new Map();
    const rec = (p, n) => {
      for (const [name, c] of n.children) {
        const cp = p + '/' + name, rel = cp.slice(root.length + 1);
        if (skip(rel, c.type)) continue;
        if (c.type === 'dir') rec(cp, c); else out.set(rel, dec.decode(c.data));
      }
    };
    const n = this.get(root); if (n && n.type === 'dir') rec(root, n);
    return out;
  }
}

// ------------------------------------------------------------------ toy git
class Git {
  constructor(fs) { this.fs = fs; this.repos = new Map(); }
  init(root) {
    const fs = this.fs;
    if (!fs.get(root + '/.git')) {
      fs.mkdir(root + '/.git');
      fs.write(root + '/.git/HEAD', 'ref: refs/heads/main\n');
      fs.write(root + '/.git/config', '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
      fs.write(root + '/.git/description', 'Unnamed repository\n');
      fs.mkdir(root + '/.git/objects'); fs.mkdir(root + '/.git/refs'); fs.mkdir(root + '/.git/refs/heads'); fs.mkdir(root + '/.git/hooks');
    }
    if (!this.repos.has(root)) this.repos.set(root, { commits: [], index: new Map(), branch: 'main' });
    return this.repos.get(root);
  }
  rootOf(cwd) { for (let p = cwd; ; p = parentOf(p)) { if (this.repos.has(p) && this.fs.get(p + '/.git')) return p; if (p === '/') return null; } }
  ignored(root, rel) {
    let pats = [];
    try { pats = dec.decode(this.fs.read(root + '/.gitignore')).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')); } catch (e) { /* none */ }
    const parts = rel.split('/');
    return pats.some(pat => {
      const dirOnly = pat.endsWith('/'); const pp = pat.replace(/\/$/, '');
      const re = new RegExp('^' + pp.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
      return parts.some((seg, i) => re.test(seg) && (!dirOnly || i < parts.length - 1)) || re.test(rel);
    });
  }
  head(r) { return r.commits.length ? r.commits[r.commits.length - 1].tree : new Map(); }
  work(root) { return this.fs.walkFiles(root, rel => rel === '.git' || rel.startsWith('.git/') || this.ignored(root, rel)); }
  touchIndex(root) { try { this.fs.write(root + '/.git/index', 'DIRC' + Math.random()); } catch (e) { /* */ } }
  status(root) {
    const r = this.repos.get(root), head = this.head(r), idx = r.index, wt = this.work(root);
    const all = [...new Set([...head.keys(), ...idx.keys(), ...wt.keys()])].sort();
    const out = [];
    for (const p of all) {
      const inH = head.has(p), inI = idx.has(p), inW = wt.has(p);
      let X = ' ', Y = ' ';
      if (inI && !inH) X = 'A'; else if (!inI && inH) X = 'D'; else if (inI && inH && idx.get(p) !== head.get(p)) X = 'M';
      if (!inI && inW) { if (X === 'D') out.push(['D', ' ', p]); out.push(['?', '?', p]); continue; }
      if (inI && !inW) Y = 'D'; else if (inI && inW && idx.get(p) !== wt.get(p)) Y = 'M';
      if (X !== ' ' || Y !== ' ') out.push([X, Y, p]);
    }
    return out;
  }
  run(args, cwd, out) {
    const fs = this.fs;
    // strip global options
    while (args[0] === '-c' || args[0] === '--no-optional-locks' || args[0] === '--no-pager' || args[0] === '-C') {
      if (args[0] === '-c') args.splice(0, 2); else if (args[0] === '-C') { cwd = norm(args[1], cwd); args.splice(0, 2); } else args.shift();
    }
    const sub = args.shift();
    if (!sub || sub === 'help' || sub === '--help') { out('usage: git <command> [<args>]\n\nmock git supports: init status add rm reset checkout commit log show diff branch rev-parse symbolic-ref config\n'); return 0; }
    if (sub === 'init') {
      const dir = norm(args.find(a => !a.startsWith('-')) || '.', cwd);
      const existed = this.repos.has(dir);
      this.init(dir);
      out(`${existed ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${dir}/.git/\n`);
      return 0;
    }
    if (sub === 'config' || sub === '--version' || sub === 'version') { if (sub !== 'config') out('git version 2.20.1 (mock)\n'); return 0; }
    const root = this.rootOf(cwd);
    if (!root) { out('fatal: not a git repository (or any of the parent directories): .git\n'); return 128; }
    const r = this.repos.get(root);
    const rel = p => { const a = norm(p, cwd); return a === root ? '' : a.slice(root.length + 1); };
    const pathspec = args.filter(a => !a.startsWith('-') || a === '-');
    const matches = (paths, specs) => paths.filter(p => specs.some(s => { const rs = rel(s); return rs === '' || p === rs || p.startsWith(rs + '/'); }));
    switch (sub) {
      case 'rev-parse': {
        if (args.includes('--show-toplevel')) { out(root + '\n'); return 0; }
        if (args.includes('--is-inside-work-tree')) { out('true\n'); return 0; }
        if (args.includes('--git-dir')) { out(root + '/.git\n'); return 0; }
        if (!r.commits.length) { out("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n"); return 128; }
        if (args.includes('--abbrev-ref')) { out(r.branch + '\n'); return 0; }
        const c = r.commits[r.commits.length - 1]; out((args.includes('--short') ? c.hash.slice(0, 7) : c.hash) + '\n'); return 0;
      }
      case 'symbolic-ref': out((args.includes('--short') ? r.branch : 'refs/heads/' + r.branch) + '\n'); return 0;
      case 'branch': out(r.commits.length ? `* ${r.branch}\n` : ''); return 0;
      case 'status': {
        const st = this.status(root);
        if (args.includes('--porcelain') || args.includes('-s') || args.includes('--short')) {
          if (args.includes('-b') || args.includes('--branch')) out(r.commits.length ? `## ${r.branch}\n` : `## No commits yet on ${r.branch}\n`);
          for (const [X, Y, p] of st) out(`${X}${Y} ${/[ "]/.test(p) ? JSON.stringify(p) : p}\n`);
          return 0;
        }
        out(`On branch ${r.branch}\n`);
        if (!r.commits.length) out('\nNo commits yet\n');
        const staged = st.filter(s => s[0] !== ' ' && s[0] !== '?'), unst = st.filter(s => s[1] !== ' ' && s[0] !== '?'), untr = st.filter(s => s[0] === '?');
        const word = { M: 'modified', A: 'new file', D: 'deleted' };
        if (staged.length) { out('\nChanges to be committed:\n  (use "git reset HEAD <file>..." to unstage)\n\n'); for (const s of staged) out(`\t\x1b[32m${(word[s[0]] + ':').padEnd(12)}${s[2]}\x1b[m\n`); }
        if (unst.length) { out('\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git checkout -- <file>..." to discard changes in working directory)\n\n'); for (const s of unst) out(`\t\x1b[31m${(word[s[1]] + ':').padEnd(12)}${s[2]}\x1b[m\n`); }
        if (untr.length) { out('\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)\n\n'); for (const s of untr) out(`\t\x1b[31m${s[2]}\x1b[m\n`); }
        if (!st.length) out(r.commits.length ? 'nothing to commit, working tree clean\n' : '\nnothing to commit (create/copy files and use "git add" to track)\n');
        else if (!staged.length) out('\nno changes added to commit (use "git add" and/or "git commit -a")\n');
        return 0;
      }
      case 'add': {
        const wt = this.work(root);
        const all = args.includes('-A') || args.includes('--all') || pathspec.includes('.') && cwd === root;
        const specs = all ? [root] : pathspec;
        if (!specs.length) { out('Nothing specified, nothing added.\n'); return 0; }
        const cand = [...new Set([...wt.keys(), ...r.index.keys()])];
        const hit = matches(cand, specs);
        if (!hit.length) { out(`fatal: pathspec '${specs[0]}' did not match any files\n`); return 128; }
        for (const p of hit) { if (wt.has(p)) r.index.set(p, wt.get(p)); else r.index.delete(p); }
        this.touchIndex(root); return 0;
      }
      case 'rm': {
        const hit = matches([...r.index.keys()], pathspec);
        if (!hit.length) { out(`fatal: pathspec '${pathspec[0]}' did not match any files\n`); return 128; }
        for (const p of hit) { r.index.delete(p); if (!args.includes('--cached')) try { fs.remove(root + '/' + p); } catch (e) { /* */ } if (!args.includes('-q')) out(`rm '${p}'\n`); }
        this.touchIndex(root); return 0;
      }
      case 'reset': {
        const head = this.head(r);
        const specs = pathspec.filter(s => s !== 'HEAD');
        const hit = specs.length ? matches([...new Set([...r.index.keys(), ...head.keys()])], specs) : [...new Set([...r.index.keys(), ...head.keys()])];
        for (const p of hit) { if (head.has(p)) r.index.set(p, head.get(p)); else r.index.delete(p); }
        this.touchIndex(root); return 0;
      }
      case 'checkout': {
        const specs = pathspec.filter(s => s !== '--');
        const hit = matches([...r.index.keys()], specs);
        if (!hit.length) { out(`error: pathspec '${specs[0]}' did not match any file(s) known to git\n`); return 1; }
        for (const p of hit) fs.write(root + '/' + p, r.index.get(p));
        return 0;
      }
      case 'commit': {
        const mi = args.findIndex(a => a === '-m' || a === '--message');
        const msg = mi >= 0 ? args[mi + 1] : '';
        if (args.includes('-a') || args.includes('-am')) { const wt = this.work(root); for (const p of [...r.index.keys()]) { if (wt.has(p)) r.index.set(p, wt.get(p)); else r.index.delete(p); } }
        const am = args.findIndex(a => a === '-am'); const message = msg || (am >= 0 ? args[am + 1] : '');
        if (!message) { out('Aborting commit due to empty commit message.\n'); return 1; }
        const head = this.head(r);
        const changed = r.index.size !== head.size || [...r.index].some(([p, c]) => head.get(p) !== c);
        if (!changed) { out(`On branch ${r.branch}\nnothing to commit, working tree clean\n`); return 1; }
        const hash = [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
        r.commits.push({ hash, msg: message, tree: new Map(r.index), time: now() });
        fs.write(root + '/.git/refs/heads/' + r.branch, hash + '\n');
        this.touchIndex(root);
        if (!args.includes('-q')) out(`[${r.branch}${r.commits.length === 1 ? ' (root-commit)' : ''} ${hash.slice(0, 7)}] ${message}\n`);
        return 0;
      }
      case 'log': {
        if (!r.commits.length) { out(`fatal: your current branch '${r.branch}' does not have any commits yet\n`); return 128; }
        for (const c of [...r.commits].reverse()) {
          if (args.includes('--oneline')) out(`\x1b[33m${c.hash.slice(0, 7)}\x1b[m ${c.msg}\n`);
          else out(`\x1b[33mcommit ${c.hash}\x1b[m\nAuthor: Student <student@example.com>\nDate:   ${new Date(c.time).toString()}\n\n    ${c.msg}\n\n`);
        }
        return 0;
      }
      case 'show': {
        const spec = args.find(a => a.includes(':'));
        if (spec) {
          const [rev, p] = spec.split(':');
          const key = p.startsWith('./') ? rel(p) : p;
          const src = rev === '' ? r.index : this.head(r);
          if (rev && !r.commits.length) { out(`fatal: invalid object name '${rev}'.\n`); return 128; }
          if (!src.has(key)) { out(`fatal: path '${key}' does not exist in '${rev || 'the index'}'\n`); return 128; }
          out(src.get(key)); return 0;
        }
        out('mock git show: only REV:path is supported\n'); return 1;
      }
      case 'diff': {
        const st = this.status(root).filter(s => (args.includes('--cached') || args.includes('--staged')) ? s[0] !== ' ' && s[0] !== '?' : s[1] !== ' ' && s[0] !== '?');
        for (const s of st) out(`\x1b[1mdiff --git a/${s[2]} b/${s[2]}\x1b[m\n`);
        return 0;
      }
      default: out(`git: '${sub}' is not a git command (mock). See 'git help'.\n`); return 1;
    }
  }
}

// ------------------------------------------------------------------ toy shell
function tokenize(line) {
  const toks = []; let cur = null, i = 0;
  const push = () => { if (cur !== null) toks.push(cur); cur = null; };
  while (i < line.length) {
    const c = line[i];
    if (c === "'") { const j = line.indexOf("'", i + 1); cur = (cur || { w: '', q: true }); cur.q = true; cur.w += line.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? line.length : j + 1; continue; }
    if (c === '"') { cur = cur || { w: '', q: true }; cur.q = true; i++; while (i < line.length && line[i] !== '"') { if (line[i] === '\\' && i + 1 < line.length) i++; cur.w += line[i++]; } i++; continue; }
    if (c === '\\') { cur = cur || { w: '' }; cur.w += line[i + 1] || ''; i += 2; continue; }
    if (c === ' ' || c === '\t') { push(); i++; continue; }
    if (line.startsWith('2>&1', i)) { push(); toks.push({ op: '2>&1' }); i += 4; continue; }
    for (const op of ['&&', '||', '>>', '2>', ';', '|', '>']) if (line.startsWith(op, i) && (op !== '2>' || cur === null)) { push(); toks.push({ op }); i += op.length; cur = undefined; break; }
    if (cur === undefined) { cur = null; continue; }
    cur = cur || { w: '' }; cur.w += c; i++;
  }
  push();
  return toks;
}

class Shell {
  constructor(vm) { this.vm = vm; }
  expand(tok, ctx) {
    if (tok.q) return [tok.w];
    let w = tok.w.replace(/\$(HOME|USER|PWD|\?)/g, (_, v) => ({ HOME, USER: 'user', PWD: ctx.cwd, '?': String(ctx.last || 0) })[v]);
    if (w === '~' || w.startsWith('~/')) w = HOME + w.slice(1);
    if (/[*?]/.test(w) && !w.includes('/')) {
      const re = new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const hits = this.vm.fs.ls(ctx.cwd).map(e => e.name).filter(n => !n.startsWith('.') && re.test(n)).sort();
      if (hits.length) return hits;
    }
    return [w];
  }
  run(line, ctx) {
    const toks = tokenize(line);
    let code = 0, skip = false, seg = [];
    const flush = (op) => {
      if (seg.length && !skip) code = ctx.last = this.simple(seg, ctx);
      seg = [];
      skip = (op === '&&' && code !== 0) || (op === '||' && code === 0);
    };
    for (const t of toks) { if (t.op === ';' || t.op === '&&' || t.op === '||') flush(t.op); else seg.push(t); }
    flush(';');
    return code;
  }
  simple(toks, ctx) {
    let words = [], redir = null, errNull = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.op === '>' || t.op === '>>') { redir = { path: norm(this.expand(toks[++i] || { w: '' }, ctx)[0], ctx.cwd), append: t.op === '>>' }; continue; }
      if (t.op === '2>') { i++; errNull = true; continue; }
      if (t.op === '2>&1') continue;
      if (t.op === '|') { ctx.out('mock shell: pipes are not supported\n'); return 1; }
      words.push(...this.expand(t, ctx));
    }
    if (!words.length) return 0;
    let buf = '';
    const out = redir ? s => { buf += s; } : ctx.out;
    let code;
    try { code = this.cmd(words, { ...ctx, out, err: errNull ? () => {} : ctx.out }); } catch (e) { (errNull ? () => {} : ctx.out)(`${words[0]}: ${e.message.replace(/^\w+: /, '')}\n`); code = 1; }
    if (redir) { try { this.vm.fs.write(redir.path, buf, redir.append); } catch (e) { ctx.out(`bash: ${e.message}\n`); return 1; } }
    return code;
  }
  cmd([c, ...a], ctx) {
    const fs = this.vm.fs, P = p => norm(p, ctx.cwd);
    const flags = a.filter(x => /^-\w/.test(x)).join(''), args = a.filter(x => !/^-\w/.test(x));
    switch (c) {
      case 'pwd': ctx.out(ctx.cwd + '\n'); return 0;
      case 'cd': { const t = P(args[0] || '~'); const n = fs.get(t); if (!n || n.type !== 'dir') { ctx.out(`bash: cd: ${args[0]}: No such file or directory\n`); return 1; } ctx.setCwd(t); return 0; }
      case 'ls': {
        const targets = args.length ? args : ['.'];
        for (const t of targets) {
          const p = P(t), n = fs.get(p);
          if (!n) { ctx.out(`ls: cannot access '${t}': No such file or directory\n`); return 2; }
          let ents = n.type === 'dir' ? fs.ls(p) : [{ name: t, type: 'file', size: n.data.length, mtime: n.mtime / 1000 }];
          if (!flags.includes('a')) ents = ents.filter(e => !e.name.startsWith('.'));
          ents.sort((x, y) => x.name.localeCompare(y.name));
          if (targets.length > 1) ctx.out(`${t}:\n`);
          const col = e => e.type === 'dir' ? `\x1b[01;34m${e.name}\x1b[0m` : e.name;
          if (flags.includes('l')) {
            for (const e of ents) ctx.out(`${e.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--'} 1 user user ${String(e.size).padStart(6)} ${new Date(e.mtime * 1000).toDateString().slice(4, 10)} ${col(e)}\n`);
          } else if (ents.length) ctx.out(ents.map(col).join('  ') + '\n');
        }
        return 0;
      }
      case 'echo': { let s = args.join(' '); if (flags.includes('e')) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t'); ctx.out(s + (flags.includes('n') ? '' : '\n')); return 0; }
      case 'cat': for (const f of args) ctx.out(dec.decode(fs.read(P(f)))); return 0;
      case 'touch': for (const f of args) { const p = P(f); const n = fs.get(p); if (n) n.mtime = now(); else fs.write(p, ''); fs.touchDir(parentOf(p)); } return 0;
      case 'mkdir': for (const f of args) fs.mkdir(P(f), flags.includes('p')); return 0;
      case 'rm': case 'rmdir': for (const f of args) { const p = P(f), n = fs.get(p); if (!n) { if (flags.includes('f')) continue; throw new Error(`cannot remove '${f}': No such file or directory`); } if (n.type === 'dir' && c === 'rm' && !flags.includes('r')) throw new Error(`cannot remove '${f}': Is a directory`); fs.remove(p); } return 0;
      case 'mv': fs.rename(P(args[0]), P(args[1])); return 0;
      case 'cp': fs.write(P(args[1]), fs.read(P(args[0]))); return 0;
      case 'clear': ctx.out('\x1b[H\x1b[2J\x1b[3J'); return 0;
      case 'whoami': ctx.out('user\n'); return 0;
      case 'hostname': ctx.out('quarto-os\n'); return 0;
      case 'date': ctx.out(new Date().toString() + '\n'); return 0;
      case 'true': case ':': return 0;
      case 'false': return 1;
      case 'test': case '[': { const i = a.indexOf('-e') >= 0 ? a.indexOf('-e') : a.indexOf('-d'); return fs.get(P(a[i + 1] || '')) ? 0 : 1; }
      case 'sleep': return 0;
      case 'exit': ctx.exit && ctx.exit(+args[0] || 0); return 0;
      case 'git': return this.vm.git.run(a, ctx.cwd, ctx.out);
      case 'python3': case 'python': ctx.out(args.length ? 'Hello, world!\n' : 'Python 3.7.3 (mock) — interactive mode not supported\n'); return 0;
      case 'help': ctx.out('mock shell commands: ls cd pwd echo cat touch mkdir rm mv cp clear whoami date git exit\n'); return 0;
      case 'sh': case 'bash': if (a[0] === '-c') return this.run(a.slice(1).join(' '), ctx); ctx.out('mock: nested shells are not supported\n'); return 1;
      default: ctx.out(`bash: ${c}: command not found\n`); return 127;
    }
  }
}

// ------------------------------------------------------------------ session (pty-ish)
class Session {
  constructor(vm, { cols = 80, rows = 24, cwd = '~' } = {}) {
    this.vm = vm; this.cols = cols; this.rows = rows;
    this.cwd = norm(cwd);
    if (vm.fs.get(this.cwd)?.type !== 'dir') throw new Error(`${cwd}: No such directory`);
    this.line = ''; this.hist = []; this.hi = 0; this.esc = '';
    this.dataCbs = new Set(); this.exitCbs = new Set(); this.closed = false;
    setTimeout(() => this.prompt(), 60);
  }
  emit(s) { if (this.closed) return; const b = enc.encode(s.replace(/\r?\n/g, '\r\n')); setTimeout(() => { for (const cb of this.dataCbs) cb(b); }, 0); this.vm.nudge(); }
  prompt() {
    const t = this.cwd === HOME ? '~' : this.cwd.startsWith(HOME + '/') ? '~' + this.cwd.slice(HOME.length) : this.cwd;
    this.emit(`\x1b]0;user@quarto-os: ${t}\x07\x1b[01;32muser@quarto-os\x1b[00m:\x1b[01;34m${t}\x1b[00m$ `);
  }
  onData(cb) { this.dataCbs.add(cb); return () => this.dataCbs.delete(cb); }
  onExit(cb) { this.exitCbs.add(cb); return () => this.exitCbs.delete(cb); }
  resize(c, r) { this.cols = c; this.rows = r; }
  close() { if (this.closed) return; this.closed = true; this.vm.sessions.delete(this); }
  exit(code = 0) { this.emit('logout\n'); setTimeout(() => { this.closed = true; for (const cb of this.exitCbs) cb(code); this.vm.sessions.delete(this); }, 20); }
  write(d) {
    if (this.closed) return;
    const s = typeof d === 'string' ? d : dec.decode(d);
    for (const ch of s) {
      if (this.esc) { this.esc += ch; if (/[A-Za-z~]/.test(ch) && this.esc.length > 2) { this.key(this.esc); this.esc = ''; } continue; }
      if (ch === '\x1b') { this.esc = ch; continue; }
      this.key(ch);
    }
  }
  setLine(l) { this.emit('\b \b'.repeat(0) + '\r\x1b[K'); this.line = l; this.prompt(); this.emit(l); }
  key(k) {
    if (k === '\r') {
      const line = this.line; this.line = ''; this.emit('\r\n');
      if (line.trim()) { this.hist.push(line); this.hi = this.hist.length; }
      let exited = false;
      const ctx = { cwd: this.cwd, out: s => this.emit(s), setCwd: c => { this.cwd = c; ctx.cwd = c; }, exit: c => { exited = true; this.exit(c); } };
      if (line.trim()) this.vm.shell.run(line, ctx);
      if (!exited) this.prompt();
    } else if (k === '\x7f' || k === '\b') { if (this.line) { this.line = this.line.slice(0, -1); this.emit('\b \b'); } }
    else if (k === '\x03') { this.line = ''; this.emit('^C\r\n'); this.prompt(); }
    else if (k === '\x04') { if (!this.line) this.exit(0); }
    else if (k === '\x0c') { this.emit('\x1b[H\x1b[2J'); this.prompt(); this.emit(this.line); }
    else if (k === '\x1b[A') { if (this.hi > 0) { this.hi--; this.setLine(this.hist[this.hi]); } }
    else if (k === '\x1b[B') { if (this.hi < this.hist.length) { this.hi++; this.setLine(this.hist[this.hi] || ''); } }
    else if (k === '\t') { /* no completion */ }
    else if (k.length === 1 && k >= ' ') { this.line += k; this.emit(k); }
  }
}

// ------------------------------------------------------------------ VM
class MockVM extends Emitter {
  constructor(config) {
    super();
    this.home = HOME;
    this.fs = new FS();
    this.git = new Git(this.fs);
    this.shell = new Shell(this);
    this.sessions = new Set();
    this.status = '';
    this.execCount = 0;
    // a repo with one commit + one modification + one untracked file
    const root = HOME + '/repo', r = this.git.init(root);
    for (const [p, c] of this.git.work(root)) if (p !== 'src/style.css') r.index.set(p, c);
    r.commits.push({ hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', msg: 'Initial commit', tree: new Map(r.index), time: now() - 864e5 });
    this.fs.write(root + '/hello.py', dec.decode(this.fs.read(root + '/hello.py')).replace('world', 'Quarto'));
    this.fs.get(root + '/.git').mtime = now() - 864e5;
    const bootMs = config.bootMs ?? 1800;
    const steps = config.fail ? ['Downloading CheerpX…', 'Checking cross-origin isolation…'] :
      ['Downloading CheerpX…', 'Connecting to disk image…', 'Booting Linux (12%)…', 'Booting Linux (48%)…', 'Booting Linux (97%)…', 'Starting quarto-os agent…'];
    this.ready = new Promise((res, rej) => {
      let i = 0;
      const tick = () => {
        if (i < steps.length) { this.status = steps[i++]; this.emit('status', this.status); setTimeout(tick, bootMs / steps.length); return; }
        if (config.fail) { rej(new Error('CheerpX needs SharedArrayBuffer, which requires a cross-origin isolated page (COOP: same-origin, COEP: require-corp).')); return; }
        this.status = 'ready'; this.emit('status', 'Ready'); res();
      };
      if (bootMs <= 0) { this.status = 'ready'; res(); } else setTimeout(tick, 30);
    });
    this.ready.catch(() => {});
    this._act = 0;
    this.nudge = () => { clearTimeout(this._act); this._act = setTimeout(() => this.emit('activity'), 250); };
  }
  async _w() { await this.ready; await new Promise(r => setTimeout(r, 5 + Math.random() * 15)); }
  async openSession(o = {}) { await this.ready; const s = new Session(this, o); this.sessions.add(s); return s; }
  async ls(p) { await this._w(); return this.fs.ls(norm(p)); }
  async stat(p) { await this._w(); const n = this.fs.get(norm(p)); return n ? { type: n.type, size: n.type === 'dir' ? 4096 : n.data.length, mtime: Math.floor(n.mtime / 1000) } : null; }
  async readFile(p) { await this._w(); return new Uint8Array(this.fs.read(norm(p))); }
  async readText(p) { return dec.decode(await this.readFile(p)); }
  async writeFile(p, data) { await this._w(); this.fs.write(norm(p), data); this.fs.touchDir(parentOf(norm(p))); }
  async mkdir(p) { await this._w(); this.fs.mkdir(norm(p), true); }
  async remove(p) { await this._w(); this.fs.remove(norm(p)); }
  async rename(a, b) { await this._w(); this.fs.rename(norm(a), norm(b)); }
  async exec(cmd, { cwd = '~' } = {}) {
    await this._w();
    this.execCount++;
    let output = '';
    const ctx = { cwd: norm(cwd), out: s => { output += s; }, setCwd: c => { ctx.cwd = c; } };
    let code;
    if (this.fs.get(ctx.cwd)?.type !== 'dir') { output = `sh: 1: cd: can't cd to ${cwd}\n`; code = 2; }
    else code = this.shell.run(cmd, ctx);
    this.nudge();
    return { code, output };
  }
  watch(dir, cb) {
    const p = norm(dir);
    const sig = () => { try { return JSON.stringify(this.fs.ls(p).sort((a, b) => a.name < b.name ? -1 : 1)); } catch (e) { return 'ERR'; } };
    let last = sig();
    const check = () => { const s = sig(); if (s !== last) { last = s; cb(s === 'ERR' ? [] : JSON.parse(s)); } };
    const iv = setInterval(check, 700);
    const off = this.on('activity', check);
    return () => { clearInterval(iv); off(); };
  }
  reset() { location.reload(); }
}

export async function createVM(config = {}, { baseUrl } = {}) {
  return new MockVM(config || {});
}
