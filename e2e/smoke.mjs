#!/usr/bin/env node
// End-to-end smoke test: runs the real Augur agent (headless build) against a real Grafana with
// Prometheus, Loki and Tempo, using the scripted stub model, then checks what actually happened.
//
// Env: GRAFANA_URL, GRAFANA_USER/GRAFANA_PASSWORD or GRAFANA_TOKEN (or none for anonymous admin),
//      STUB_URL (default http://127.0.0.1:8787), AUGUR_DATASOURCE_UID (optional: route model calls
//      through the Augur datasource backend instead of calling the stub directly).
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, '..', 'augur-app', 'dist-headless', 'augur-headless.mjs');
const dir = mkdtempSync(join(tmpdir(), 'augur-e2e-'));
const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const auth = process.env.GRAFANA_TOKEN
  ? `Bearer ${process.env.GRAFANA_TOKEN}`
  : process.env.GRAFANA_USER
    ? `Basic ${Buffer.from(`${process.env.GRAFANA_USER}:${process.env.GRAFANA_PASSWORD ?? ''}`).toString('base64')}`
    : undefined;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};

const via = process.env.AUGUR_DATASOURCE_UID ? `Augur datasource ${process.env.AUGUR_DATASOURCE_UID}` : 'stub directly';
console.log(`Augur e2e smoke against ${grafana} (model via ${via})`);
const env = {
  ...process.env,
  GRAFANA_URL: grafana,
  MODEL_BASE_URL: process.env.AUGUR_DATASOURCE_UID ? '' : (process.env.STUB_URL ?? 'http://127.0.0.1:8787'),
  MODEL: process.env.MODEL ?? 'stub-model',
  AUGUR_APPLY: 'auto',
  AUGUR_TRAJECTORY: join(dir, 'trajectory.json'),
  AUGUR_ANSWER: join(dir, 'answer.txt'),
};
const t0 = Date.now();
const r = spawnSync(process.execPath, [runner, 'Give me an overview of service health and build a dashboard for it.'], { env, encoding: 'utf8', timeout: 180_000 });
process.stderr.write(r.stderr ?? '');
check(r.status === 0, `headless run exits 0 (got ${r.status}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (r.status !== 0) {
  process.exit(1);
}
const traj = JSON.parse(readFileSync(env.AUGUR_TRAJECTORY, 'utf8'));
const answer = readFileSync(env.AUGUR_ANSWER, 'utf8');
check(!/STUB REQUEST PROBLEMS/.test(answer), `model requests well-formed${/STUB REQUEST PROBLEMS/.test(answer) ? `: ${answer}` : ''}`);
check(answer.includes('E2E COMPLETE'), 'run reached the final answer');

const results = traj.steps.flatMap((s) => (s.tool_calls ?? []).map((c, i) => ({ name: c.function_name, input: c.arguments, out: s.observation?.results?.[i]?.content ?? '', error: !!s.observation?.results?.[i]?.extra?.is_error })));
check(results.length >= 6, `tool calls recorded in ATIF trajectory (${results.length})`);
for (const c of results) {
  check(!c.error && !/^(Error|HTTP \d{3})/.test(c.out), `${c.name} succeeded${c.error || /^(Error|HTTP)/.test(c.out) ? `: ${c.out.slice(0, 200)}` : ''}`);
}
const out = (name, n = 0) => results.filter((c) => c.name === name)[n]?.out ?? '';
check(/prometheus/i.test(out('list_datasources')) && /loki/i.test(out('list_datasources')) && /tempo/i.test(out('list_datasources')), 'list_datasources sees Prometheus, Loki and Tempo');
check(/payment-service|order-service|api-gateway/.test(out('query_prometheus')), 'Prometheus query returned real series');
check(/\[evidence E\d+\]/.test(out('query_prometheus')), 'Prometheus result carries an evidence id');
check(/error|warn|info/i.test(out('query_loki', 0)), 'Loki metric query returned level series');
check(/error/i.test(out('query_loki', 1)) && !/no (log )?lines/i.test(out('query_loki', 1)), 'Loki log query returned error lines');
check(/[0-9a-f]{16,32}/.test(out('search_traces')), 'Tempo search returned trace ids');
const applied = traj.final_metrics.extra.applied ?? [];
check(applied.length === 1 && !applied[0].error, `dashboard proposal applied (${JSON.stringify(applied)})`);
check(traj.final_metrics.extra.evidence >= 3, `evidence ledger has ≥3 entries (${traj.final_metrics.extra.evidence})`);

// The dashboard must exist in Grafana with working queries.
const search = await fetch(`${grafana}/api/search?tag=augur-e2e`, { headers: auth ? { Authorization: auth } : {} }).then((x) => x.json());
const hit = search.find((d) => d.title === 'Augur e2e: service overview');
check(!!hit, 'dashboard exists in Grafana');
if (hit) {
  const dash = await fetch(`${grafana}/api/dashboards/uid/${hit.uid}`, { headers: auth ? { Authorization: auth } : {} }).then((x) => x.json());
  const panels = dash.dashboard.panels ?? [];
  check(panels.length === 2 && panels.every((p) => p.datasource?.uid && p.targets?.length), 'dashboard panels have datasources and targets');
  const anno = (dash.dashboard.annotations?.list ?? []).find((a) => a.name === 'Deployments');
  check(anno?.datasource?.type === 'loki' && /deploy/.test(anno?.target?.expr ?? ''), 'Loki deployment annotation saved');
  await fetch(`${grafana}/api/dashboards/uid/${hit.uid}`, { method: 'DELETE', headers: auth ? { Authorization: auth } : {} });
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
