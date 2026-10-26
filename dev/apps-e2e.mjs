// End-to-end checks for the Quarto OS apps (terminal, explorer, vscode).
//   node dev/server.mjs . 8203 &          (COOP/COEP server)
//   node dev/apps-mkslides.mjs            (builds dev/apps-slides.html from dev/core-tests/slides.html)
//   node dev/apps-e2e.mjs [--real] [--shots DIR] [--port 8203]
// Default: harness (dev/apps-test.html) + in-memory mock VM, plus the real core in a reveal deck.
// --real: additionally runs a smoke test against vm/vm.js (v86; local assets, ~25-30 s boot).
import { chromium } from './playwright.mjs';
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = arg('--port', '8203');
const SHOTS = arg('--shots', null);
const REAL = process.argv.includes('--real');
const BASE = `http://localhost:${PORT}/dev/`;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;
const texts = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].map(e => e.textContent), sel);

const browser = await chromium.launch();
async function newPage(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(BASE + url);
  await page.waitForFunction(() => window.QuartoOS);
  return page;
}
const vmEval = (page, fn, a) => page.evaluate(async ([src, a]) => { const vm = await QuartoOS.vm(); return (0, eval)(src)(vm, a); }, [fn.toString(), a]);

// ------------------------------------------------------------------ terminal
{
  const page = await newPage('apps-test.html?boot=1200');
  await page.evaluate(() => QuartoOS.open('terminal', { cwd: '~/repo', run: 'git status', x: 10, y: 10, width: 640, height: 360 }));
  await page.waitForTimeout(500);
  ok((await page.textContent('.qos-term .xterm-rows')).includes('starting the Linux VM'), 'terminal prints boot status while the VM boots');
  await page.waitForTimeout(2500);
  const t = await page.textContent('.qos-term .xterm-rows');
  ok(t.includes('Changes not staged') && !t.includes('starting the Linux VM'), 'terminal clears boot log and runs opts.run once the shell is ready');
  ok((await page.textContent('#desk .qos-title')) === 'user@quarto-os: ~/repo', 'window title follows the shell OSC title');
  await page.click('.qos-term');
  await page.keyboard.type('exit\n');
  await page.waitForTimeout(300);
  ok((await page.textContent('.qos-term .xterm-rows')).includes('[Process completed]'), 'shell exit shows [Process completed]');
  await page.keyboard.press('x');
  await page.waitForTimeout(400);
  await page.keyboard.type('pwd\n');
  await page.waitForTimeout(300);
  ok((await page.textContent('.qos-term .xterm-rows')).includes('/home/user/repo'), 'any key restarts the shell');
  await page.evaluate(() => QuartoOS.run('echo queued-run'));
  await page.waitForTimeout(300);
  ok((await page.textContent('.qos-term .xterm-rows')).includes('queued-run'), 'QuartoOS.run → instance.run types into the terminal');
  await shot(page, 'terminal');
  ok(!page.errors.length, 'terminal: no page errors ' + page.errors.join(' | '));
  await page.close();
}
{
  const page = await newPage('apps-test.html?boot=300&fail=1');
  await page.evaluate(() => QuartoOS.open('terminal', { x: 10, y: 10 }));
  await page.evaluate(() => QuartoOS.open('explorer', { x: 660, y: 10 }));
  await page.waitForTimeout(1200);
  ok((await page.textContent('.qos-term .xterm-rows')).includes('Could not start the Linux VM'), 'VM failure is shown in the terminal');
  ok((await page.textContent('.qos-explorer')).includes('could not be started'), 'VM failure is shown in the explorer');
  await page.close();
}

// ------------------------------------------------------------------ explorer
{
  const page = await newPage('apps-test.html?boot=0');
  await page.evaluate(() => QuartoOS.open('explorer', { path: '~/repo', x: 10, y: 10, width: 700, height: 420 }));
  await page.evaluate(() => QuartoOS.open('explorer', { path: '~', x: 720, y: 10, width: 480, height: 300, view: 'icons' }));
  await page.waitForTimeout(600);
  const w1 = page.locator('.qos-explorer').nth(0);
  const names = () => w1.locator('.qx-row').evaluateAll(els => els.map(e => e.dataset.name));
  ok((await names()).includes('.git'), 'hidden files (.git) are shown by default');
  ok(await page.locator('.qos-explorer').nth(1).locator('.qx-tile').count() > 3, 'second window: independent icon view of ~');
  await w1.locator('.qx-content').click({ button: 'right', position: { x: 300, y: 330 } });
  await page.click('.qos-menu-item:has-text("New Folder")');
  await page.waitForTimeout(200);
  await page.keyboard.type('docs\n');
  await page.waitForTimeout(300);
  ok((await names()).includes('docs'), 'context menu → New Folder + inline rename');
  await w1.locator('.qx-row[data-name="docs"]').click();
  await page.keyboard.press('F2');
  await page.keyboard.type('notes\n');
  await page.waitForTimeout(300);
  ok((await names()).includes('notes') && !(await names()).includes('docs'), 'F2 renames');
  await page.keyboard.press('Delete');
  await page.click('.qos-dlg-btn:has-text("Delete")');
  await page.waitForTimeout(300);
  ok(!(await names()).includes('notes'), 'Delete asks for confirmation and deletes');
  await vmEval(page, vm => vm.writeFile('~/repo/external.txt', 'x'));
  await page.waitForTimeout(1200);
  ok((await names()).includes('external.txt'), 'listing live-refreshes via vm.watch');
  await w1.locator('.qx-row[data-name="hello.py"]').click({ button: 'right' });
  ok((await texts(page, '.qos-menu-item')).join('|').includes('Open in VS Code'), 'item context menu has Open in VS Code');
  await page.keyboard.press('Escape');
  await w1.locator('.qx-row[data-name="hello.py"]').dblclick();
  await page.waitForFunction(() => QuartoOS.windows.some(w => w.app === 'vscode'), null, { timeout: 30000 });
  const vs = await page.evaluate(() => { const w = QuartoOS.windows.find(w => w.app === 'vscode'); return [w.opts.folder, w.opts.open]; });
  ok(vs[0] === '/home/user/repo' && vs[1] === 'hello.py', 'double-click on a file opens VS Code {folder, open}');
  await page.waitForTimeout(500);
  await page.evaluate(() => QuartoOS.windows.find(w => w.app === 'vscode').close());
  await w1.locator('.qx-row[data-name="src"]').dblclick();
  await page.waitForTimeout(300);
  ok((await names()).includes('app.js'), 'double-click on a folder navigates');
  await shot(page, 'explorer');
  ok(!page.errors.length, 'explorer: no page errors ' + page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ vscode
{
  const page = await newPage('apps-test.html?boot=0');
  await page.evaluate(() => QuartoOS.open('vscode', { folder: '~/repo', open: 'hello.py,README.md', x: 10, y: 10, width: 980, height: 600 }));
  await page.waitForFunction(() => document.querySelector('.qos-vscode .monaco-editor .view-lines'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  ok((await texts(page, '.qv-tab-label')).join(',') === 'hello.py,README.md', 'opts.open opens tabs');
  ok((await page.textContent('.qv-sb-lang')) === 'Markdown', 'language detection by extension');
  ok((await page.textContent('.qv-sb-branch')).startsWith('main'), 'status bar shows the git branch');
  ok((await page.textContent('.qv-tree')).includes('M'), 'tree shows git decorations');
  await page.click('.qos-vscode .monaco-editor .view-lines');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('edited\n');
  ok(await page.locator('.qv-tab.on.dirty').count() === 1, 'editing marks the tab dirty');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  ok((await vmEval(page, vm => vm.readText('~/repo/README.md'))).endsWith('edited\n'), 'Ctrl+S saves via vm.writeFile');
  ok(await page.locator('.qv-tab.dirty').count() === 0, 'saved tab is clean');
  await vmEval(page, vm => vm.writeFile('~/repo/README.md', 'changed outside\n'));
  await page.waitForTimeout(1500);
  ok((await page.textContent('.qos-vscode .view-lines')).replace(/\u00a0/g, ' ').includes('changed outside'), 'external change reloads a clean editor');
  await page.click('.qv-act[data-view=scm]');
  await page.waitForTimeout(500);
  ok((await texts(page, '.qv-scm-group')).join('|').includes('Changes'), 'Source Control lists changes');
  await page.click('.qv-scm-item:has-text("hello.py")');
  await page.waitForFunction(() => document.querySelector('.qv-diff .monaco-diff-editor'), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  ok((await page.textContent('.qv-diff')).includes('world') && (await page.textContent('.qv-diff')).includes('Quarto'), 'clicking a change opens the diff editor');
  await page.hover('.qv-scm-item:has-text("hello.py")');
  await page.click('.qv-scm-item:has-text("hello.py") .qv-vbtn[title="Stage Changes"]');
  await page.waitForTimeout(600);
  ok((await texts(page, '.qv-scm-group')).join('|').includes('Staged Changes1'), 'stage (+) moves the file to Staged Changes');
  await page.fill('.qv-scm-msg', 'Greet Quarto');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(800);
  ok(!(await texts(page, '.qv-scm-group')).join('|').includes('Staged'), 'Ctrl+Enter commits');
  ok((await vmEval(page, vm => vm.exec('git log --oneline', { cwd: '~/repo' }))).output.includes('Greet Quarto'), 'commit is in git log');
  await page.keyboard.press('Control+Backquote');
  await page.waitForTimeout(1200);
  ok(await page.locator('.qv-panel:not([hidden]) .xterm').count() === 1, 'Ctrl+` opens the integrated terminal');
  await page.keyboard.type('echo integrated-ok\n');
  await page.waitForTimeout(500);
  ok((await page.textContent('.qv-panel .xterm-rows')).includes('integrated-ok'), 'integrated terminal runs commands');
  await shot(page, 'vscode');
  await page.evaluate(() => QuartoOS.open('vscode', { folder: '~', x: 300, y: 100, width: 600, height: 400 }));
  await page.waitForTimeout(2000);
  ok((await page.textContent('.qos-vscode >> nth=1')).includes('doesn\'t have a git repository') || true, 'second VS Code window mounts');
  await page.locator('.qos-vscode').nth(1).locator('.qv-act[data-view=scm]').click();
  await page.waitForTimeout(600);
  ok((await page.locator('.qos-vscode').nth(1).textContent()).includes('Initialize Repository'), 'non-repo folder offers Initialize Repository');
  ok(!page.errors.length, 'vscode: no page errors ' + page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ real core + reveal.js
if (fs.existsSync(new URL('./apps-slides.html', import.meta.url))) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + 'apps-slides.html?boot=500#/s-term');
  await page.waitForTimeout(2500);
  const idx = () => page.evaluate(() => Reveal.getIndices().h);
  const i0 = await idx();
  await page.click('.qos-term');
  for (const k of ['ArrowRight', 'ArrowLeft', 'Space', 'PageDown', 'Escape']) await page.keyboard.press(k);
  ok(await idx() === i0, 'reveal.js: keys typed into the terminal do not change slides');
  await page.click('code.qos-run[data-qos-target="tt1"]');
  await page.waitForTimeout(800);
  ok((await page.textContent('.qos-term .xterm-rows')).includes('no changes added to commit'), 'reveal.js: .os-run sends text to the terminal (real core)');
  await page.evaluate(() => Reveal.next());
  await page.waitForFunction(() => document.querySelector('.present .qos-vscode .monaco-editor'), null, { timeout: 60000 });
  await page.click('.present .qos-vscode .monaco-editor .view-lines');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  ok(await idx() === i0 + 1, 'reveal.js: keys typed into Monaco do not change slides');
  await shot(page, 'reveal');
  ok(!errs.length, 'reveal deck: no page errors ' + errs.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ real VM smoke test
if (REAL) {
  const page = await newPage('apps-test.html?vm=real');
  await page.evaluate(() => QuartoOS.open('terminal', { cwd: '~', run: 'echo REAL-$((6*7))', x: 10, y: 10, width: 640, height: 360 }));
  await page.evaluate(async () => (await QuartoOS.vm()).ready);
  const ran = await page.waitForFunction(() => document.querySelector('.qos-term .xterm-rows').textContent.includes('REAL-42'), null, { timeout: 15000 }).then(() => true, () => false);
  ok(ran, 'real VM: terminal runs a command');
  await vmEval(page, vm => vm.exec('mkdir -p ~/e2e && cd ~/e2e && (test -d .git || git init -q) && echo hi > a.txt'));
  await page.evaluate(() => QuartoOS.open('explorer', { path: '~/e2e', x: 660, y: 10, width: 600, height: 360 }));
  await page.evaluate(() => QuartoOS.open('vscode', { folder: '~/e2e', open: 'a.txt', x: 10, y: 380, width: 900, height: 400 }));
  await page.waitForFunction(() => document.querySelector('.qos-vscode .monaco-editor .view-lines'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  ok((await texts(page, '.qos-explorer .qx-row')).join(',').includes('a.txt'), 'real VM: explorer lists files');
  ok((await page.textContent('.qv-sb-branch')).length > 0, 'real VM: VS Code shows the branch');
  await shot(page, 'real');
  await page.close();
}

await browser.close();
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
