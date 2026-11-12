import { buildDashboardDraft, saveDashboard, wildcardVars, DashboardSpec } from './dashboard';
import { draftDashboardTool } from './tools/dashboards';
import { ctxWith, fakeHttp, seriesResponse, DATASOURCES } from './testUtils';

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
    // two stats share the first line
    expect(panels[0].gridPos).toEqual({ h: 4, w: 12, x: 0, y: 0 });
    expect(panels[1].gridPos).toEqual({ h: 4, w: 12, x: 12, y: 0 });
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
    expect(out).toMatch(/revise_draft/);
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

describe('dashboard builder v2', () => {
  const { inferUnit, lintPanel, layout, buildPanel } = jest.requireActual('./dashboard');
  const { applyRevision, reviseDraftTool, draftDashboardTool } = jest.requireActual('./tools/dashboards');

  it('infers units from metric names', () => {
    expect(inferUnit('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))')).toBe('s');
    expect(inferUnit('sum(rate(http_requests_total[5m]))')).toBe('reqps');
    expect(inferUnit('sum(rate(kafka_messages_total[5m]))')).toBe('ops');
    expect(inferUnit('sum(rate(container_network_receive_bytes_total[5m]))')).toBe('Bps');
    expect(inferUnit('container_memory_working_set_bytes')).toBe('bytes');
    expect(inferUnit('sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))')).toBe('percentunit');
    expect(inferUnit('100 * sum(a) / sum(b)')).toBe('percent');
    expect(inferUnit('sum(rate(container_cpu_usage_seconds_total[5m]))')).toBe('percentunit');
    expect(inferUnit('up')).toBeUndefined();
  });

  it('fixes short rate windows and infers units; warns about raw counters, buckets and missing le', () => {
    const r = lintPanel(
      { title: 'RPS', type: 'timeseries', queries: [{ expr: 'sum(rate(http_requests_total[5m]))' }, { expr: 'sum(increase(x_total[1h]))' }] },
      'prometheus'
    );
    expect(r.panel.queries[0].expr).toBe('sum(rate(http_requests_total[$__rate_interval]))');
    expect(r.panel.queries[1].expr).toBe('sum(increase(x_total[1h]))'); // long windows are intentional
    expect(r.panel.unit).toBe('reqps');
    expect(r.fixes).toEqual(['panel "RPS": rate window → $__rate_interval', 'panel "RPS": unit reqps inferred from the metric name']);

    expect(lintPanel({ title: 'Raw', type: 'stat', queries: [{ expr: 'http_requests_total' }] }, 'prometheus').warnings[0]).toMatch(/counter; wrap it in rate/);
    expect(lintPanel({ title: 'B', type: 'timeseries', queries: [{ expr: 'sum(rate(lat_seconds_bucket[5m]))' }] }, 'prometheus').warnings[0]).toMatch(/histogram_quantile/);
    expect(lintPanel({ title: 'Q', type: 'timeseries', queries: [{ expr: 'histogram_quantile(0.9, sum by (svc) (rate(lat_seconds_bucket[5m])))' }] }, 'prometheus').warnings[0]).toMatch(/needs "le"/);
    expect(lintPanel({ title: 'H', type: 'heatmap', queries: [{ expr: 'sum by (le) (rate(lat_seconds_bucket[5m]))' }] }, 'prometheus').warnings).toEqual([]);
    expect(lintPanel({ title: 'L', type: 'logs', queries: [{ expr: 'sum(count_over_time({app="x"}[5m]))' }] }, 'loki').warnings[0]).toMatch(/logs panels need a log query/);
    expect(lintPanel({ title: 'L2', type: 'timeseries', queries: [{ expr: '{app="x"} |= "error"' }] }, 'loki').warnings[0]).toMatch(/LogQL metric query/);
  });

  it('lays out stats across the row, fills rows, equalises heights, and nests collapsed sections', () => {
    let id = 100;
    const mk = (spec: any) => ({ spec, json: { id: id++, type: spec.type, title: spec.title } });
    const panels = [
      mk({ title: 's1', type: 'stat' }),
      mk({ title: 's2', type: 'stat' }),
      mk({ title: 's3', type: 'stat' }),
      mk({ title: 's4', type: 'stat' }),
      mk({ title: 's5', type: 'stat' }),
      mk({ title: 'a', type: 'timeseries', row: 'Traffic' }),
      mk({ title: 'b', type: 'timeseries', row: 'Traffic', height: 10 }),
      mk({ title: 'c', type: 'timeseries', row: 'Traffic' }),
      mk({ title: 'd', type: 'table', row: 'Details' }),
    ];
    const { panels: out } = layout(panels, 0, () => id++, ['Details']);
    const pos = (t: string) => out.find((p: any) => p.title === t)?.gridPos ?? out.flatMap((p: any) => p.panels ?? []).find((p: any) => p.title === t)?.gridPos;
    // 5 stats share one row of 24 columns (4 each, last one takes the remainder).
    expect([1, 2, 3, 4, 5].map((i) => pos(`s${i}`).w)).toEqual([4, 4, 4, 4, 8]);
    expect(new Set([1, 2, 3, 4, 5].map((i) => pos(`s${i}`).y))).toEqual(new Set([0]));
    // Two time series per line; a lone last one stretches to the full width.
    expect(pos('a')).toMatchObject({ w: 12, x: 0, h: 10 }); // heights equalised within a line
    expect(pos('b')).toMatchObject({ w: 12, x: 12, h: 10 });
    expect(pos('c')).toMatchObject({ w: 24, x: 0 });
    expect(pos('a').y).toBe(pos('b').y);
    // Collapsed section: its panels live inside the row.
    const details = out.find((p: any) => p.type === 'row' && p.title === 'Details');
    expect(details).toMatchObject({ collapsed: true });
    expect(details.panels.map((p: any) => p.title)).toEqual(['d']);
    expect(out.find((p: any) => p.title === 'd')).toBeUndefined();
  });

  it('builds legends, overrides, mappings, links, repeats and modern defaults', () => {
    const warnings: string[] = [];
    const p = buildPanel(
      {
        title: 'Latency',
        type: 'timeseries',
        datasource_uid: 'mimir',
        queries: [{ expr: 'x' }],
        unit: 's',
        legend: { mode: 'table', placement: 'right' },
        threshold_style: 'line',
        thresholds: [
          { value: null, color: 'green' },
          { value: 0.5, color: 'red' },
        ],
        overrides: [{ match: '.*error.*', regex: true, color: 'red', axis: 'right', unit: 'percentunit' }],
        links: [{ title: 'Runbook', url: 'https://wiki/runbook' }],
        repeat: '$service',
        description: 'p95 by service',
      },
      7,
      DATASOURCES,
      warnings
    );
    expect(p.options.legend).toMatchObject({ displayMode: 'table', placement: 'right', calcs: ['mean', 'max', 'lastNotNull'] });
    expect(p.fieldConfig.defaults.custom).toMatchObject({ thresholdsStyle: { mode: 'line' }, gradientMode: 'opacity', lineInterpolation: 'smooth' });
    expect(p.fieldConfig.overrides[0]).toEqual({
      matcher: { id: 'byRegexp', options: '.*error.*' },
      properties: [
        { id: 'unit', value: 'percentunit' },
        { id: 'color', value: { mode: 'fixed', fixedColor: 'red' } },
        { id: 'custom.axisPlacement', value: 'right' },
      ],
    });
    expect(p.links).toEqual([{ title: 'Runbook', url: 'https://wiki/runbook' }]);
    expect(p).toMatchObject({ repeat: 'service', repeatDirection: 'h' });

    const stat = buildPanel({ title: 'Up', type: 'stat', datasource_uid: 'mimir', queries: [{ expr: 'up' }], mappings: [{ value: '1', text: 'Up', color: 'green' }, { from: 0, to: 0.5, text: 'Down', color: 'red' }], color_mode: 'background', sparkline: false }, 8, DATASOURCES, warnings);
    expect(stat.options).toMatchObject({ colorMode: 'background', graphMode: 'none' });
    expect(stat.fieldConfig.defaults.mappings).toEqual([
      { type: 'value', options: { '1': { text: 'Up', color: 'green', index: 0 } } },
      { type: 'range', options: { from: 0, to: 0.5, result: { text: 'Down', color: 'red', index: 1 } } },
    ]);
    expect(warnings).toEqual([]);
  });

  it('falls back to timeseries when a panel type is not installed', () => {
    const warnings: string[] = [];
    const p = buildPanel({ title: 'T', type: 'state-timeline', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }, 1, DATASOURCES, warnings, new Set(['timeseries', 'stat']));
    expect(p.type).toBe('timeseries');
    expect(warnings[0]).toMatch(/not installed/);
  });

  it('builds flame graph panels for Pyroscope and heatmap-format bucket queries', () => {
    const fg = buildPanel({ title: 'CPU', type: 'flamegraph', datasource_uid: 'pyro', queries: [{ label_selector: '{service_name="checkout"}' }] }, 1, [...DATASOURCES, { uid: 'pyro', name: 'Pyroscope', type: 'grafana-pyroscope-datasource' }], []);
    expect(fg.targets[0]).toMatchObject({ queryType: 'profile', profileTypeId: 'process_cpu:cpu:nanoseconds:cpu:nanoseconds', labelSelector: '{service_name="checkout"}' });
    const hm = buildPanel({ title: 'H', type: 'heatmap', datasource_uid: 'mimir', queries: [{ expr: 'sum by (le) (rate(x_bucket[$__rate_interval]))' }] }, 2, DATASOURCES, []);
    expect(hm.targets[0]).toMatchObject({ format: 'heatmap', legendFormat: '{{le}}' });
  });

  it('applies revisions: update, add after, remove, move, sections, variables', () => {
    const spec = {
      title: 'Svc',
      panels: [
        { title: 'RPS', type: 'timeseries', row: 'Traffic', queries: [{ expr: 'a' }] },
        { title: 'Errors', type: 'timeseries', row: 'Traffic', queries: [{ expr: 'b' }] },
        { title: 'Logs', type: 'logs', queries: [{ expr: '{x="y"}' }] },
      ],
      variables: [{ name: 'svc', type: 'custom', query: 'a,b' }],
    };
    const { spec: out, changes, problems } = applyRevision(spec, {
      update_panels: [{ title: 'rps', set: { type: 'stat', unit: 'reqps' } }],
      add_panels: [{ title: 'Latency', type: 'heatmap', after: 'RPS', row: 'Traffic' }],
      remove_panels: ['Logs', 'Nope'],
      move_panels: [{ title: 'Errors', row: 'Failures' }],
      collapse_rows: ['Failures'],
      add_variables: [{ name: 'ns', type: 'query', query: 'label_values(up, namespace)' }],
      title: 'Service overview',
    });
    expect(out.title).toBe('Service overview');
    expect(out.panels.map((p: any) => `${p.title}:${p.type}:${p.row ?? ''}`)).toEqual(['RPS:stat:Traffic', 'Latency:heatmap:Traffic', 'Errors:timeseries:Failures']);
    expect(out.panels[0].unit).toBe('reqps');
    expect(out.collapsed_rows).toEqual(['Failures']);
    expect(out.variables.map((v: any) => v.name)).toEqual(['svc', 'ns']);
    expect(problems).toEqual(['no panel titled "Nope" to remove']);
    expect(changes).toContain('+ added "Latency" (heatmap)');
    expect(spec.panels).toHaveLength(3); // input untouched
  });

  it('revise_draft edits the latest draft and numbers revisions', async () => {
    const drafts: any[] = [];
    const ctx = ctxWith(fakeHttp(() => seriesResponse([{ labels: { job: 'api' }, values: [1, 2] }])), { latestDraft: () => drafts[drafts.length - 1] });
    const draftTool = draftDashboardTool((d: any) => drafts.push(d));
    const revise = reviseDraftTool((d: any) => drafts.push(d));
    await draftTool.run({ title: 'Svc', panels: [{ title: 'RPS', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'sum(rate(http_requests_total[5m]))' }] }] }, ctx);
    expect(drafts[0].revision).toBe(1);
    expect(drafts[0].fixes).toContain('panel "RPS": rate window → $__rate_interval');
    const out = await revise.run({ update_panels: [{ title: 'RPS', set: { legend: { mode: 'table' } } }], add_panels: [{ title: 'Up', type: 'stat', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }] }, ctx);
    expect(drafts).toHaveLength(2);
    expect(drafts[1].revision).toBe(2);
    expect(drafts[1].json.panels.map((p: any) => p.title)).toEqual(['RPS', 'Up']);
    expect(out).toContain('(revision 2)');
    expect(out).toContain('~ updated "RPS" (legend)');
    await expect(reviseDraftTool(() => undefined).run({ remove_panels: ['x'] }, ctxWith(fakeHttp(() => ({})), { latestDraft: () => undefined }))).rejects.toThrow(/no dashboard draft/);
  });

  it('warns about panels returning too many series', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ labels: { pod: `p${i}` }, values: [1] }));
    const draft = await buildDashboardDraft(
      { title: 'X', panels: [{ title: 'Pods', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'sum by (pod) (rate(cpu_seconds_total[5m]))' }] }] },
      ctxWith(fakeHttp(() => seriesResponse(many)))
    );
    expect(draft.warnings.join(' ')).toMatch(/40 series is hard to read/);
  });
});

describe('saving revisions', () => {
  const { applyProposal } = jest.requireActual('./apply');
  const draft = { title: 'Svc', revision: 3, folderUid: 'f1', json: { uid: 'new-uid', title: 'Svc', panels: [] } };

  it('updates the saved dashboard only if it is still at the version Augur saved', async () => {
    const http = fakeHttp(() => ({ url: '/d/saved-uid/svc', uid: 'saved-uid', version: 8 }));
    const r = await applyProposal(http, { kind: 'dashboard', draft } as any, { replaceUid: 'saved-uid', replaceVersion: 7 });
    expect(http.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/dashboards/db',
      body: { dashboard: { uid: 'saved-uid', id: null, version: 7 }, folderUid: 'f1', overwrite: false, message: 'Augur: revision 3' },
    });
    expect(r).toEqual({ message: 'Updated dashboard "Svc" (revision 3)', url: '/d/saved-uid/svc', uid: 'saved-uid', version: 8 });

    const changed = fakeHttp(() => {
      throw Object.assign(new Error('version-mismatch'), { status: 412 });
    });
    await expect(applyProposal(changed, { kind: 'dashboard', draft } as any, { replaceUid: 'saved-uid', replaceVersion: 7 })).rejects.toThrow(/changed in Grafana since Augur saved it/);
    await expect(applyProposal(http, { kind: 'dashboard', draft } as any, { replaceUid: 'saved-uid' })).rejects.toThrow(/version of the saved dashboard is unknown/);
  });

  it('creates a new dashboard otherwise', async () => {
    const http = fakeHttp(() => ({ url: '/d/new-uid/svc' }));
    const r = await applyProposal(http, { kind: 'dashboard', draft } as any);
    expect(http.calls[0].body).not.toMatchObject({ overwrite: true });
    expect(r.message).toBe('Saved dashboard "Svc"');
  });
});
