// Builds dev/apps-slides.html (+ dev/apps-doc.html): the core agent's rendered reveal.js test deck
// (dev/core-tests/slides.html, real Quarto reveal theme) with the slides replaced
// by app windows, loading the REAL core (_extensions/quarto-os/quarto-os.js) and
// the real apps. VM: mock by default, `?vm=real` uses vm/vm.js.
//   node dev/apps-mkslides.mjs && node dev/server.mjs . 8203 → /dev/apps-slides.html
import fs from 'node:fs';
import path from 'node:path';
const D = path.dirname(new URL(import.meta.url).pathname);
let html = fs.readFileSync(path.join(D, 'core-tests/slides.html'), 'utf8');
html = html.replace(/(src|href)="slides_files\/libs\/quarto-contrib\/quarto-os-[^/]+\/quarto-os\.(js|css)"/g, '$1="../_extensions/quarto-os/quarto-os.$2"');
html = html.replace(/(src|href)="slides_files\//g, '$1="core-tests/slides_files/');
const q = o => JSON.stringify(o).replace(/"/g, '&quot;');
const win = (o, id) => `<div ${id ? `id="${id}" ` : ''}class="qos-window" data-qos-opts="${q(o)}"></div>`;
const slides = `
<section id="title-slide" class="quarto-title-block center"><h1 class="title">Quarto OS apps in reveal.js</h1></section>
<section id="s-term" class="slide level2"><h2>Terminal (480×300, inline)</h2>
${win({ app: 'terminal', width: '480px', height: '300px', cwd: '~/repo' }, 'tt1')}
<p>Run <code class="qos-run" data-qos-target="tt1">git status</code> or <code class="qos-run">ls -la</code>.</p></section>
<section id="s-code" class="slide level2"><h2>VS Code (floating 480×300)</h2>
${win({ app: 'vscode', folder: '~/repo', open: 'hello.py', x: '40', y: '120', width: '480', height: '300' })}
${win({ app: 'explorer', path: '~/repo', x: '540', y: '120', width: '480', height: '300' })}</section>
<section id="s-desk" class="slide level2"><h2>Desktop</h2>
<div id="desk" class="qos-desktop" data-qos-opts="${q({ height: '540px' })}">
${win({ app: 'vscode', folder: '~/repo', open: 'README.md', x: '20', y: '20', width: '620', height: '400' })}
${win({ app: 'terminal', cwd: '~/repo', x: '380', y: '230', width: '520', height: '260' })}
</div></section>`;
html = html.replace(/(<div class="slides">)[\s\S]*?(\n    <\/div>\n)/, `$1${slides}$2`);
const mock = `<script>(function(){var p=new URLSearchParams(location.search);if(p.get('vm')!=='real'&&window.QuartoOS){var P=null;window.QuartoOS.vm=function(){return P||(P=import('./apps-mock-vm.js').then(function(m){return m.createVM({bootMs:+(p.get('boot')||1500)})}))}}})();</script>`;
html = html.replace(/(<script src="\.\.\/_extensions\/quarto-os\/quarto-os\.js"[^>]*><\/script>)/, `$1\n${mock}`);
fs.writeFileSync(path.join(D, 'apps-slides.html'), html);
console.log('wrote dev/apps-slides.html', html.length);

// Same for a regular Quarto HTML page (Bootstrap): dev/core-tests/doc.html → dev/apps-doc.html
let doc = fs.readFileSync(path.join(D, 'core-tests/doc.html'), 'utf8');
doc = doc.replace(/(src|href)="doc_files\/libs\/quarto-contrib\/quarto-os-[^/]+\/quarto-os\.(js|css)"/g, '$1="../_extensions/quarto-os/quarto-os.$2"');
doc = doc.replace(/(src|href)="doc_files\//g, '$1="core-tests/doc_files/');
const body = `
<h1>Quarto OS apps in a Bootstrap page</h1>
<p>Inline windows in the document flow.</p>
${win({ app: 'terminal', height: '300px', cwd: '~/repo' }, 'dt1')}
<p>Run <code class="qos-run" data-qos-target="dt1">git status</code>.</p>
${win({ app: 'explorer', path: '~/repo', height: '320px' })}
${win({ app: 'vscode', folder: '~/repo', open: 'hello.py', height: '420px' })}`;
doc = doc.replace(/(<main class="content" id="quarto-document-content">)[\s\S]*?(<\/main>)/, `$1${body}$2`);
doc = doc.replace(/(<script src="\.\.\/_extensions\/quarto-os\/quarto-os\.js"[^>]*><\/script>)/, `$1\n${mock}`);
fs.writeFileSync(path.join(D, 'apps-doc.html'), doc);
console.log('wrote dev/apps-doc.html', doc.length);
