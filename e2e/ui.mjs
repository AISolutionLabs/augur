#!/usr/bin/env node
// UI end-to-end check in a real browser: opens the Augur app page in Grafana, sends a message, and
// waits for the scripted run to finish with real tool calls, evidence and a dashboard draft card.
// Env: GRAFANA_URL, CHROME_PATH (default /usr/bin/google-chrome), SCREENSHOT (optional png path).
import puppeteer from 'puppeteer-core';

const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--window-size=1500,1100'],
});
const failures = [];
const check = (ok, what) => (console.log(`${ok ? '✓' : '✗'} ${what}`), ok || failures.push(what));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && /augur/i.test(m.text()) && errors.push(m.text()));

  await page.goto(`${grafana}/a/augur-assistant-app`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const box = await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 30_000 }).catch(() => null);
  check(!!box, 'Augur app page renders with the composer');
  if (box) {
    await box.type('Give me an overview of service health and build a dashboard for it.');
    await page.keyboard.press('Enter');
    const done = await page.waitForFunction(() => document.body.innerText.includes('E2E COMPLETE'), { timeout: 120_000 }).then(() => true, () => false);
    check(done, 'scripted run finished in the UI');
    const text = await page.evaluate(() => document.querySelector('[data-testid="claude-timeline"]')?.innerText ?? '');
    check(!/STUB REQUEST PROBLEMS/.test(text), 'model requests from the browser were well-formed');
    check(!/HTTP (4|5)\d\d/.test(text), 'no tool or gateway errors shown');
    check(!!(await page.$('[data-testid="claude-draft-card"]')), 'dashboard draft card shown (not applied without a click)');
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  if (process.env.SCREENSHOT) {
    await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} UI check(s) failed` : '\nAll UI checks passed');
process.exit(failures.length ? 1 : 0);
