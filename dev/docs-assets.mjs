// Regenerates the raster demo assets used by the docs site:
//   examples/assets/flow-field.jpg      generative artwork (canvas)
//   examples/assets/unit-circle.{webm,mp4}  4 s seamless loop (canvas frames -> ffmpeg)
//
// Usage: node dev/docs-assets.mjs        (needs ffmpeg on PATH)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(here, '../examples/assets');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qos-assets-'));

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

// ---------------------------------------------------------------- flow field
await page.setViewportSize({ width: 900, height: 560 });
await page.setContent(`<canvas id=c width=900 height=560 style="display:block"></canvas>`);
await page.evaluate(() => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0f1530'); bg.addColorStop(1, '#22123a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const field = (x, y) => Math.sin(x * 0.0062) * 1.7 + Math.cos(y * 0.0081) * 1.3 + Math.sin((x + y) * 0.0021) * 0.9;
  const palette = ['#5ec8ff', '#7a8bff', '#c77dff', '#ff7eb6', '#ffb86b'];
  g.lineCap = 'round';
  for (let i = 0; i < 1500; i++) {
    let x = rnd() * W, y = rnd() * H;
    const col = palette[Math.floor((x / W) * 0.6 * palette.length + rnd() * 2) % palette.length];
    g.strokeStyle = col; g.globalAlpha = 0.18 + rnd() * 0.3; g.lineWidth = 0.6 + rnd() * 1.6;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 70; s++) {
      const a = field(x, y);
      x += Math.cos(a) * 3; y += Math.sin(a) * 3;
      if (x < 0 || y < 0 || x > W || y > H) break;
      g.lineTo(x, y);
    }
    g.stroke();
  }
});
await page.locator('#c').screenshot({ path: path.join(out, 'flow-field.jpg'), type: 'jpeg', quality: 82 });

// ---------------------------------------------------------------- unit circle loop
const W = 640, H = 360, FPS = 25, SECONDS = 4, N = FPS * SECONDS;
await page.setViewportSize({ width: W, height: H });
await page.setContent(`<canvas id=c width=${W} height=${H} style="display:block"></canvas>`);
await page.evaluate(({ W, H }) => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  const cx = 150, cy = H / 2, R = 92, x0 = 290, span = 310;
  window.draw = (t /* 0..1 */) => {
    const th = t * Math.PI * 2;
    g.fillStyle = '#0f172a'; g.fillRect(0, 0, W, H);
    // grid
    g.strokeStyle = 'rgba(148,163,184,.14)'; g.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); }
    for (let y = 20; y <= H; y += 40) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke(); }
    // axes
    g.strokeStyle = 'rgba(226,232,240,.45)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx - R - 24, cy); g.lineTo(x0 + span + 16, cy); g.stroke();
    g.beginPath(); g.moveTo(x0, cy - R - 24); g.lineTo(x0, cy + R + 24); g.stroke();
    // circle
    g.strokeStyle = '#7a8bff'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    // sine curve, scrolling so the loop is seamless
    g.strokeStyle = '#ff7eb6'; g.lineWidth = 3.5; g.beginPath();
    for (let i = 0; i <= span; i++) {
      const a = th - (i / span) * Math.PI * 2;
      const y = cy - Math.sin(a) * R;
      i ? g.lineTo(x0 + i, y) : g.moveTo(x0 + i, y);
    }
    g.stroke();
    const px = cx + Math.cos(th) * R, py = cy - Math.sin(th) * R;
    // radius + projection
    g.strokeStyle = '#e2e8f0'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(px, py); g.stroke();
    g.setLineDash([6, 6]); g.strokeStyle = 'rgba(255,184,107,.9)';
    g.beginPath(); g.moveTo(px, py); g.lineTo(x0, py); g.stroke(); g.setLineDash([]);
    // dots
    g.fillStyle = '#ffb86b'; g.beginPath(); g.arc(px, py, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff7eb6'; g.beginPath(); g.arc(x0, py, 7, 0, Math.PI * 2); g.fill();
    // labels
    g.fillStyle = '#e2e8f0'; g.font = '600 20px system-ui, sans-serif';
    g.fillText('y = sin θ', x0 + span - 84, 36);
    g.font = '15px system-ui, sans-serif'; g.fillStyle = 'rgba(226,232,240,.7)';
    g.fillText('θ = ' + Math.round(t * 360) + '°', cx - 28, cy + R + 44);
  };
}, { W, H });
for (let i = 0; i < N; i++) {
  await page.evaluate((t) => window.draw(t), i / N);
  await page.locator('#c').screenshot({ path: path.join(tmp, `f${String(i).padStart(4, '0')}.png`) });
}
await browser.close();

const frames = path.join(tmp, 'f%04d.png');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', frames,
  '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '42', '-pix_fmt', 'yuv420p', '-row-mt', '1', '-an',
  path.join(out, 'unit-circle.webm')]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', frames,
  '-c:v', 'libx264', '-crf', '30', '-preset', 'veryslow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
  path.join(out, 'unit-circle.mp4')]);
// poster frame
fs.copyFileSync(path.join(tmp, 'f0012.png'), path.join(out, 'unit-circle-poster.png'));
fs.rmSync(tmp, { recursive: true, force: true });
for (const f of ['flow-field.jpg', 'unit-circle.webm', 'unit-circle.mp4', 'unit-circle-poster.png'])
  console.log(f, fs.statSync(path.join(out, f)).size, 'bytes');
