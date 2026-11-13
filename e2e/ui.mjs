#!/usr/bin/env node
// UI end-to-end check in a real browser: opens the Augur app page in Grafana, sends a message, and
// waits for the scripted run to finish with real tool calls, evidence and a dashboard draft card.
// Env: GRAFANA_URL, CHROME_PATH (default /usr/bin/google-chrome), SCREENSHOT (optional png path).
import puppeteer from 'puppeteer-core';
import { appendFileSync } from 'node:fs';
import { LOOP_PROBE } from './probe.mjs';

const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--window-size=1500,1100'],
});


const failures = [];
const runs = Math.max(1, Number(process.env.E2E_UI_RUNS ?? 1));
let loopCount = 0;
const check = (ok, what) => (console.log(`${ok ? '✓' : '✗'} ${what}`), ok || failures.push(what));

// One UI pass in a fresh browser context (empty localStorage, so a new conversation each time).
async function runOnce(n) {
  const tag = runs > 1 ? `[run ${n}/${runs}] ` : '';
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1500, height: 1100 });
    await page.evaluateOnNewDocument(LOOP_PROBE);
    const errors = [];
    page.on('pageerror', (e) => {
      const stack = String(e.stack ?? e).split('\n').slice(0, 60).join('\n    ');
      const loop = /#185|Maximum update depth/.test(String(e)) ? page.evaluate(() => window.__augurLoopReport?.()).catch(() => 'no probe') : Promise.resolve('');
      loop.then((report) => {
        const line = `${String(e).split('\n')[0]}${report ? ` [loop: ${report}]` : ''}`;
        if (report) loopCount++;
        errors.push(line);
        console.log(`${tag}page error:\n    ${stack}${report ? `\n    loop probe: ${report}` : ''}`);
      });
    });
    page.on('console', (m) => m.type() === 'error' && /augur/i.test(m.text()) && errors.push(m.text()));

    await page.goto(`${grafana}/a/augur-assistant-app`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const box = await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 30_000 }).catch(() => null);
    check(!!box, `${tag}Augur app page renders with the composer`);
    if (box) {
      await box.type('Give me an overview of service health and build a dashboard for it.');
      await page.keyboard.press('Enter');
      const done = await page.waitForFunction(() => document.body.innerText.includes('E2E COMPLETE'), { timeout: 120_000 }).then(() => true, () => false);
      check(done, `${tag}scripted run finished in the UI`);
      const text = await page.evaluate(() => document.querySelector('[data-testid="claude-timeline"]')?.innerText ?? '');
      check(!/STUB REQUEST PROBLEMS/.test(text), `${tag}model requests from the browser were well-formed`);
      check(!/HTTP (4|5)\d\d/.test(text), `${tag}no tool or gateway errors shown`);
      // The transcript scrolls inside its own pane and the composer stays on screen.
      const layout = await page.evaluate(() => {
        const tl = document.querySelector('[data-testid="claude-timeline"]');
        const box = document.querySelector('textarea[aria-label="Message Augur"]')?.getBoundingClientRect();
        return {
          overflow: tl ? getComputedStyle(tl).overflowY : 'missing',
          scrolls: tl ? tl.scrollHeight > tl.clientHeight : false,
          composerVisible: !!box && box.bottom <= window.innerHeight + 1 && box.top >= 0,
        };
      });
      check(layout.overflow === 'auto' && layout.composerVisible, `${tag}transcript scrolls in its own pane, composer visible (${JSON.stringify(layout)})`);
      check(!!(await page.$('[data-testid="claude-draft-card"]')), `${tag}dashboard draft card shown (not applied without a click)`);
      // The draft previews with real Grafana panels: every panel finishes loading and none errors.
      const preview = await page
        .waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="augur-draft-preview"]');
            const cells = el?.querySelectorAll('[aria-label^="Preview of"]') ?? [];
            return cells.length > 0 && !el.querySelector('[data-testid="Spinner"]') ? { cells: cells.length, alerts: el.querySelectorAll('[role="alert"]').length, canvases: el.querySelectorAll('canvas').length } : false;
          },
          { timeout: 30_000 }
        )
        .then((h) => h.jsonValue(), () => undefined);
      check(!!preview && preview.cells === 2, `${tag}draft preview renders both panels${preview ? ` (${JSON.stringify(preview)})` : ''}`);
      check(!!preview && preview.alerts === 0, `${tag}draft preview panels render without errors`);
    }
    // Let late renders (folder list, scrolling) settle so errors after the run are caught too.
    await new Promise((r) => setTimeout(r, 3000));
    check(errors.length === 0, `${tag}no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
    if (process.env.SCREENSHOT && (n === runs || errors.length)) {
      await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
    }
  } finally {
    await context.close();
  }
}

try {
  for (let n = 1; n <= runs; n++) {
    await runOnce(n);
  }
} finally {
  await browser.close();
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `| Augur in use (chat run on the Augur page) | ${runs} | ${loopCount} | ${failures.length ? 'failed' : 'ok'} |\n`
  );
}
if (loopCount) {
  console.log(`\n${loopCount} React update loop(s) (#185) during ${runs} Augur run(s).`);
}
console.log(failures.length ? `\n${failures.length} UI check(s) failed` : `\nAll UI checks passed${runs > 1 ? ` (${runs} runs)` : ''}`);
process.exit(failures.length ? 1 : 0);
