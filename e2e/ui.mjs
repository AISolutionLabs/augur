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

// Minimal React DevTools hook (React reports commits to it even in production builds). It keeps a
// summary of recent commits so an update loop (React error #185) can be attributed to components
// and to where they are on the page, which the error's own stack cannot show.
const LOOP_PROBE = () => {
  const recent = [];
  const scrolls = [];
  addEventListener('scroll', () => { scrolls.push(performance.now()); if (scrolls.length > 400) scrolls.shift(); }, { capture: true, passive: true });
  const nameOf = (f) => (typeof f.type === 'function' || typeof f.type === 'object' ? f.type?.displayName || f.type?.name || f.type?.render?.name || '?' : null);
  const where = (f) => {
    for (let n = f; n; n = n.child) {
      if (n.stateNode instanceof Element) {
        const el = n.stateNode.closest('[data-testid],[aria-label],[id]');
        const inAugur = !!n.stateNode.closest('[data-testid="claude-timeline"],[data-testid^="claude-"],[data-testid^="augur-"]') || location.pathname.includes('augur') && !!n.stateNode.closest('main');
        return `${el ? (el.getAttribute('data-testid') ? `testid=${el.getAttribute('data-testid')}` : el.getAttribute('aria-label') ? `aria=${el.getAttribute('aria-label')}` : `id=${el.id}`) : n.stateNode.tagName.toLowerCase()}${inAugur ? ' (augur)' : ''}`;
      }
    }
    return '';
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      const changed = [];
      const visit = (f, depth) => {
        for (let n = f; n && changed.length < 12 && depth < 400; n = n.sibling) {
          const a = n.alternate;
          if (a && nameOf(n) && (n.memoizedState !== a.memoizedState || n.memoizedProps !== a.memoizedProps) && n.flags & 0x4 /* Update */) {
            changed.push(`${nameOf(n)}@${where(n)}`);
          }
          if (n.child && (n.subtreeFlags || n.flags)) visit(n.child, depth + 1);
        }
      };
      try { visit(root.current.child, 0); } catch (e) { changed.push('probe-error'); }
      recent.push({ t: performance.now(), changed });
      if (recent.length > 120) recent.shift();
    },
  };
  window.__augurLoopReport = () => {
    const last = recent.slice(-60);
    const counts = {};
    for (const c of last) for (const x of new Set(c.changed)) counts[x] = (counts[x] ?? 0) + 1;
    const span = last.length ? Math.round(last[last.length - 1].t - last[0].t) : 0;
    const from = last.length ? last[0].t : 0;
    const scrolled = scrolls.filter((t) => t >= from).length;
    return `${last.length} commits in ${span}ms, ${scrolled} scroll events; most updated: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`;
  };
};

const failures = [];
const runs = Math.max(1, Number(process.env.E2E_UI_RUNS ?? 1));
const grafanaOnly = [];
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
      const stack = String(e.stack ?? e).split('\n').slice(0, 8).join('\n    ');
      const loop = /#185|Maximum update depth/.test(String(e)) ? page.evaluate(() => window.__augurLoopReport?.()).catch(() => 'no probe') : Promise.resolve('');
      loop.then((report) => {
        const line = `${String(e).split('\n')[0]}${report ? ` [loop: ${report}]` : ''}`;
        // An update loop whose components are all Grafana's own chrome (none inside Augur) is a
        // Grafana bug, seen intermittently on Grafana 13: report it, but don't fail Augur's test.
        if (report && !report.includes('(augur)') && /most updated: (?!none)/.test(report)) {
          grafanaOnly.push(line);
          console.log(`${tag}⚠ update loop in Grafana's own UI (no Augur components involved):\n    ${line}`);
          return;
        }
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
      check(!!(await page.$('[data-testid="claude-draft-card"]')), `${tag}dashboard draft card shown (not applied without a click)`);
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
if (grafanaOnly.length) {
  console.log(`\n⚠ ${grafanaOnly.length} update loop(s) in Grafana's own UI during ${runs} run(s); not counted as Augur failures.`);
}
console.log(failures.length ? `\n${failures.length} UI check(s) failed` : `\nAll UI checks passed${runs > 1 ? ` (${runs} runs)` : ''}`);
process.exit(failures.length ? 1 : 0);
