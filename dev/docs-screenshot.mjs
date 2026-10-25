// Regenerates examples/assets/screenshot.png (used by README.md): the git lesson
// after a few steps, with VS Code's Source Control view open.
// Usage: node dev/server.mjs _site 8204 &   then   node dev/docs-screenshot.mjs [baseUrl]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'node:path';

const base = process.argv[2] || 'http://localhost:8204';
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../examples/assets/screenshot.png');
const steps = [
  'git init', 'git status', 'git add README.md pancakes.md', 'git commit -m "Add README and pancake recipe"',
  'git branch -M main', "sed -i 's/1 tbsp sugar/2 tbsp sugar/' pancakes.md", 'clear; git diff',
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
await page.goto(`${base}/examples/git-lesson.html`);
await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows')].some((r) => /\$\s*$/m.test(r.innerText)), null, { timeout: 180000 });
await page.waitForTimeout(2000);
for (const s of steps) {
  await page.evaluate((s) => QuartoOS.run(s, 'git'), s);
  await page.waitForTimeout(2500);
}
await page.locator('#code .qv-activity > :nth-child(2)').click();
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const h = [...document.querySelectorAll('.lesson-steps h2')].find((e) => e.textContent.includes('Change something'));
  window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 90);
});
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
