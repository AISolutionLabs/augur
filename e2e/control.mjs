#!/usr/bin/env node
// Control arm for the intermittent React #185 seen in Grafana 13's chrome: browse Grafana's own
// pages (never the Augur page) with the same commit probe and count update loops. Run against a
// Grafana without Augur and one with Augur installed but idle; compare with the Augur-in-use runs.
// Never fails: it reports. Env: GRAFANA_URL, CHROME_PATH, CONTROL_LABEL, CONTROL_PASSES (5).
import puppeteer from 'puppeteer-core';
import { appendFileSync } from 'node:fs';
import { LOOP_PROBE } from './probe.mjs';

const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const label = process.env.CONTROL_LABEL ?? 'control';
const passes = Math.max(1, Number(process.env.CONTROL_PASSES ?? 5));
const dwellMs = Number(process.env.CONTROL_DWELL_MS ?? 6000);
const pages = ['/', '/explore', '/dashboards', '/alerting/list', '/connections/datasources', '/drilldown', '/'];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--window-size=1500,1100'],
});
const loops = [];
let errors = 0;
try {
  for (let n = 1; n <= passes; n++) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1500, height: 1100 });
    await page.evaluateOnNewDocument(LOOP_PROBE);
    page.on('pageerror', (e) => {
      errors++;
      if (/#185|Maximum update depth/.test(String(e))) {
        page
          .evaluate(() => window.__augurLoopReport?.())
          .catch(() => 'no probe')
          .then((r) => {
            loops.push(`[pass ${n}] ${r}`);
            console.log(`⚠ [${label}] pass ${n}: update loop: ${r}`);
          });
      } else {
        console.log(`[${label}] pass ${n}: page error: ${String(e).split('\n')[0]}`);
      }
    });
    for (const p of pages) {
      await page.goto(`${grafana}${p}`, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, dwellMs));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
const line = `${label}: ${loops.length} update loop(s) in ${passes} pass(es) of ${pages.length} pages; ${errors} page error(s) total`;
console.log(`\nCONTROL RESULT ${line}`);
loops.forEach((l) => console.log(`  ${l}`));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${label} | ${passes} | ${loops.length} | ok |\n`);
  if (loops.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, loops.map((l) => `|  ↳ ${l.replace(/\|/g, '/')} | | | |\n`).join(''));
}
