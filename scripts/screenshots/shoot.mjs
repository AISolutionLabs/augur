// Serves the harness and captures screenshots with headless Chrome.
//   node build.mjs && node shoot.mjs [chrome-path]
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'out');
const dest = path.resolve(here, '../../docs/img');
const chrome = process.argv[2] ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const file = path.join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(dest, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
try {
  const shots = [
    { scene: 'investigation', done: 'Recommended actions', file: 'augur-investigation.png', width: 1500 },
    { scene: 'actions', done: 'Three proposals are ready', file: 'augur-proposals.png', width: 1300 },
  ];
  for (const s of shots) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error(`[${s.scene}] page error:`, e.message));
    await page.setViewport({ width: s.width, height: 1000, deviceScaleFactor: 1.5 });
    await page.goto(`${base}/${s.scene}.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 60_000 }, s.done);
    await new Promise((r) => setTimeout(r, 800)); // let icons and fonts settle
    // Grow the viewport to the full content height so the sticky composer sits at the real bottom.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewport({ width: s.width, height, deviceScaleFactor: 1.5 });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(dest, s.file) });
    console.log('saved', path.join(dest, s.file));
    await page.close();
  }
  // Animated walkthrough: capture frames while a (slowed-down) investigation runs.
  const frames = path.join(out, 'frames');
  await mkdir(frames, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${base}/investigation-slow.html`, { waitUntil: 'networkidle0' });
  let n = 0;
  let doneAt = 0;
  for (let i = 0; i < 160; i++) {
    await page.evaluate(() => document.querySelector('[data-testid="claude-timeline"]')?.lastElementChild?.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
    const done = await page.evaluate(() => document.body.innerText.includes('Recommended actions'));
    if (done && !doneAt) {
      doneAt = i;
    }
    if (doneAt && i - doneAt > 8) {
      break;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  await page.close();
  console.log('captured', n, 'frames');
} finally {
  await browser.close();
  server.close();
}
