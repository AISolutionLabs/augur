import { buildDashboardDraft, saveDashboard, wildcardVars, DashboardSpec } from './dashboard';
import { draftDashboardTool } from './tools/dashboards';
import { ctxWith, fakeHttp, seriesResponse } from './testUtils';

const spec: DashboardSpec = {
  title: 'Checkout RED',
  tags: ['checkout'],
  variables: [{ name: 'namespace', type: 'query', datasource_uid: 'mimir', query: 'label_values(http_requests_total, namespace)' }],
  panels: [
    { title: 'RPS', type: 'stat', datasource_uid: 'mimir', unit: 'reqps', queries: [{ expr: 'sum(rate(http_requests_total{namespace="$namespace"}[$__rate_interval]))' }] },
    { title: 'Error %', type: 'stat', datasource_uid: 'mimir', unit: 'percentunit', queries: [{ expr: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))' }] },
    { title: 'Latency p95', type: 'timeseries', datasource_uid: 'mimir', unit: 's', row: 'Latency', queries: [{ expr: 'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))', legend: 'p95' }] },
    { title: 'Errors', type: 'logs', datasource_uid: 'loki', row: 'Logs', queries: [{ expr: '{namespace="$namespace"} |= "error"' }] },
    { title: 'Slow traces', type: 'traces', datasource_uid: 'tempo', row: 'Traces', queries: [{ traceql: '{duration > 1s}' }] },
  ],
};

describe('dashboard builder', () => {
  it('builds valid JSON with rows, grid layout, variables and per-type targets', async () => {
    const http = fakeHttp(() => seriesResponse([{ labels: {}, values: [1] }]));
    const d = await buildDashboardDraft(spec, ctxWith(http));
    const panels = d.json.panels as any[];
    expect(d.json.uid).toMatch(/^cl-/);
    expect(d.json.id).toBeNull();
    expect(d.json.tags).toContain('claude');
    expect(d.json.templating.list[0]).toMatchObject({ name: 'namespace', type: 'query', datasource: { uid: 'mimir', type: 'prometheus' } });
    // two stats side by side on the first line
    expect(panels[0].gridPos).toEqual({ h: 4, w: 6, x: 0, y: 0 });
    expect(panels[1].gridPos).toEqual({ h: 4, w: 6, x: 6, y: 0 });
    const rows = panels.filter((p) => p.type === 'row').map((p) => p.title);
    expect(rows).toEqual(['Latency', 'Logs', 'Traces']);
    const logs = panels.find((p) => p.title === 'Errors');
    expect(logs.targets[0]).toMatchObject({ queryType: 'range', expr: '{namespace="$namespace"} |= "error"' });
    const traces = panels.find((p) => p.title === 'Slow traces');
    expect(traces.type).toBe('table');
    expect(traces.targets[0]).toMatchObject({ queryType: 'traceql', query: '{duration > 1s}' });
    // no overlapping panels
    const boxes = panels.map((p) => p.gridPos);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    expect(d.warnings).toEqual([]);
    expect(d.checks.filter((c) => c.status === 'ok')).toHaveLength(5);
  });

  it('dry-runs queries with variables wildcarded and reports empty/error panels', async () => {
    const http = fakeHttp((c) => {
      const q = c.body.queries[0];
      if (q.expr?.includes('code=~')) {
        return { results: { A: { frames: [] } } };
      }
      if (q.datasource.type === 'tempo') {
        return { results: { A: { error: 'invalid TraceQL' } } };
      }
      return seriesResponse([{ labels: {}, values: [1] }]);
    });
    const d = await buildDashboardDraft(spec, ctxWith(http));
    const first = http.calls.find((c) => c.body.queries[0].expr?.startsWith('sum(rate(http_requests_total{namespace'));
    expect(first!.body.queries[0].expr).toBe('sum(rate(http_requests_total{namespace=~".+"}[$__rate_interval]))');
    expect(d.checks.find((c) => c.panel === 'Error %')!.status).toBe('empty');
    expect(d.checks.find((c) => c.panel === 'Slow traces')!.status).toBe('error');
  });

  it('warns on unknown datasources, undefined variables and duplicates', async () => {
    const d = await buildDashboardDraft(
      {
        title: 'x',
        check_queries: false,
        panels: [
          { title: 'a', type: 'timeseries', datasource_uid: 'missing', queries: [{ expr: 'up{x="$nope"}' }] },
          { title: 'a', type: 'stat', datasource_uid: 'mimir', queries: [{ expr: 'up' }] },
        ],
      },
      ctxWith(fakeHttp(() => ({})))
    );
    expect(d.warnings.join('\n')).toMatch(/not found/);
    expect(d.warnings.join('\n')).toMatch(/\$nope/);
    expect(d.warnings.join('\n')).toMatch(/duplicate/);
  });

  it('extends an existing dashboard as a new copy below existing panels', async () => {
    const existing = { dashboard: { id: 7, uid: 'orig', title: 'Old', version: 12, tags: ['team'], panels: [{ id: 3, type: 'stat', gridPos: { x: 0, y: 0, w: 24, h: 6 } }], templating: { list: [] } } };
    const http = fakeHttp((c) => (c.method === 'GET' ? existing : seriesResponse([])));
    const d = await buildDashboardDraft({ title: 'Old + latency', extend_dashboard_uid: 'orig', check_queries: false, panels: [{ title: 'p95', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }] }, ctxWith(http));
    expect(d.json.uid).not.toBe('orig');
    expect(d.json.id).toBeNull();
    expect(d.json.panels).toHaveLength(2);
    expect(d.json.panels[1].id).toBe(4);
    expect(d.json.panels[1].gridPos.y).toBe(6);
  });

  it('saves only as a new dashboard (overwrite false)', async () => {
    const http = fakeHttp(() => ({ uid: 'u', url: '/d/u/x', status: 'success', version: 1 }));
    const d = await buildDashboardDraft({ ...spec, check_queries: false }, ctxWith(http));
    await saveDashboard(http, d, 'folder1');
    const call = http.calls.find((c) => c.url === '/api/dashboards/db')!;
    expect(call.body).toMatchObject({ overwrite: false, folderUid: 'folder1' });
  });

  it('draft_dashboard tool hands the draft to the UI and tells the model what to fix', async () => {
    const drafts: any[] = [];
    const http = fakeHttp(() => ({ results: { A: { frames: [] } } }));
    const out = await draftDashboardTool((d) => drafts.push(d)).run({ ...spec }, ctxWith(http));
    expect(drafts).toHaveLength(1);
    expect(out).toMatch(/need attention/);
    expect(out).toMatch(/call draft_dashboard again/);
  });

  it('wildcards variables without touching Grafana macros', () => {
    expect(wildcardVars('rate(x{a="$a",b=~"${b}"}[$__rate_interval]) by ($group)')).toBe('rate(x{a=~".+",b=~".+"}[$__rate_interval]) by (job)');
  });
});

describe('query annotations', () => {
  const deploys = {
    name: 'Deployments',
    datasource_uid: 'loki',
    expr: '{service=~"order-service|payment-service"} | json | event="deployment"',
    tag_keys: 'service',
    title_format: 'Deploy {{service}}',
    text_format: '{{version}}',
  };

  it('adds Loki and Prometheus annotations next to the built-in one', async () => {
    const d = await buildDashboardDraft(
      {
        title: 'Svc',
        check_queries: false,
        annotations: [deploys, { name: 'Restarts', datasource_uid: 'mimir', expr: 'changes(process_start_time_seconds[5m]) > 0' }],
        panels: [{ title: 'p', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }],
      },
      ctxWith(fakeHttp(() => ({})))
    );
    const list = d.json.annotations.list;
    expect(list.map((a: any) => a.name)).toEqual(['Annotations & Alerts', 'Deployments', 'Restarts']);
    expect(list[1]).toMatchObject({ datasource: { uid: 'loki', type: 'loki' }, enable: true, expr: deploys.expr, target: { expr: deploys.expr }, tagKeys: 'service', titleFormat: 'Deploy {{service}}', textFormat: '{{version}}', instant: false });
    expect(list[2]).toMatchObject({ datasource: { uid: 'mimir', type: 'prometheus' }, step: '60s' });
    expect(d.warnings).toEqual([]);
  });

  it('warns about unsupported datasources and missing queries', async () => {
    const d = await buildDashboardDraft(
      { title: 'x', check_queries: false, annotations: [{ name: 'T', datasource_uid: 'tempo', expr: '' }], panels: [{ title: 'p', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }] },
      ctxWith(fakeHttp(() => ({})))
    );
    expect(d.warnings.join(' ')).toMatch(/expr is required/);
    expect(d.warnings.join(' ')).toMatch(/only Loki and Prometheus/);
  });

  it('keeps existing annotations when extending a dashboard, and edits can add them', async () => {
    const { buildDashboardEdit } = await import('./tools/actions');
    const existing = { uid: 'orig', title: 'Orig', version: 3, panels: [], annotations: { list: [{ builtIn: 1, name: 'Annotations & Alerts' }, { name: 'Old' }] } };
    const http = fakeHttp(() => ({ dashboard: existing, meta: { canSave: true, folderUid: 'f' } }));
    const ext = await buildDashboardDraft({ title: 'Copy', extend_dashboard_uid: 'orig', check_queries: false, annotations: [deploys], panels: [{ title: 'p', type: 'stat', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }] }, ctxWith(http));
    expect(ext.json.annotations.list.map((a: any) => a.name)).toEqual(['Annotations & Alerts', 'Old', 'Deployments']);

    const edit = await buildDashboardEdit({ dashboard_uid: 'orig', add_annotations: [deploys, { ...deploys, name: 'Old' }] }, ctxWith(http));
    expect(edit.json.annotations.list.map((a: any) => a.name)).toEqual(['Annotations & Alerts', 'Old', 'Deployments']);
    expect(edit.changes).toContain('+ add annotation "Deployments"');
    expect(edit.warnings).toContain('annotation "Old" already exists');
  });
});
