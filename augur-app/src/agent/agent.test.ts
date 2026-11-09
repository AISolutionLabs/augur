import { runAgent, compact, buildRequest } from './runner';
import { MessagesRequest, MessagesResponse, Message, AgentEvent } from './types';
import { parseTime, resolveRange, autoStepSeconds } from './time';
import { summarizeTimeSeries, summarizeLogs, clip } from './frames';
import { buildToolset } from './tools';
import { promQuery, lokiQuery, tempoGetTrace, promMetricNames } from './tools/observability';
import { interpolateVars, runPanelQueries, listAlerts, getAnnotations } from './tools/grafanaObjects';
import { buildSystemPrompt } from './prompts';
import { buildReport } from '../report';
import { ctxWith, fakeHttp, NOW, seriesResponse, logsResponse, DATASOURCES } from './testUtils';

describe('time', () => {
  it('parses relative, epoch and ISO', () => {
    expect(parseTime('now-1h', NOW)).toBe(NOW - 3600_000);
    expect(parseTime('now-1d+2h', NOW)).toBe(NOW - 86_400_000 + 7_200_000);
    expect(parseTime(1_700_000_000, NOW)).toBe(1_700_000_000_000);
    expect(parseTime('2026-11-09T10:00:00Z', NOW)).toBe(Date.parse('2026-11-09T10:00:00Z'));
    expect(() => parseTime('now-1x', NOW)).toThrow(/unsupported/);
  });
  it('rejects inverted ranges and picks sane steps', () => {
    expect(() => resolveRange({ start: 'now', end: 'now-1h' }, { from: 0, to: 1 }, NOW)).toThrow(/before/);
    expect(autoStepSeconds({ from: NOW - 3600_000, to: NOW })).toBe(30);
    expect(autoStepSeconds({ from: NOW - 7 * 86_400_000, to: NOW })).toBe(7200);
  });
});

describe('frame summaries', () => {
  it('summarises series with stats, peak and samples, sorted by max', () => {
    const text = summarizeTimeSeries(
      seriesResponse([
        { labels: { pod: 'a' }, values: [1, 2, 3] },
        { labels: { pod: 'b' }, values: [5, 50, 5] },
      ]).results.A.frames
    );
    expect(text.indexOf('pod="b"')).toBeLessThan(text.indexOf('pod="a"'));
    expect(text).toContain('max=50');
    expect(text).toContain('peak_at=');
    expect(text).toContain('samples:');
  });
  it('reports empty results helpfully', () => {
    expect(summarizeTimeSeries([])).toMatch(/No data/);
  });
  it('summarises logs newest first and clips long lines', () => {
    const r = logsResponse([
      { t: NOW - 2000, line: 'old', labels: { app: 'x' } },
      { t: NOW - 1000, line: 'new ' + 'z'.repeat(1000), labels: { app: 'x' } },
    ]);
    const text = summarizeLogs(r.results.A.frames, 10);
    expect(text.indexOf('new')).toBeLessThan(text.indexOf('old'));
    expect(text).toContain('…');
  });
  it('clips oversized tool output', () => {
    expect(clip('x'.repeat(20_000), 100)).toMatch(/truncated/);
  });
});

describe('observability tools', () => {
  it('query_prometheus posts a range query to /api/ds/query with datasource and step', async () => {
    const http = fakeHttp(() => seriesResponse([{ labels: { job: 'api' }, values: [1, 2] }]));
    const out = await promQuery.run({ datasource_uid: 'mimir', expr: 'sum(rate(x[5m]))', start: 'now-6h' }, ctxWith(http));
    const call = http.calls[0];
    expect(call.url).toBe('/api/ds/query');
    expect(call.body.queries[0]).toMatchObject({ datasource: { uid: 'mimir', type: 'prometheus' }, expr: 'sum(rate(x[5m]))', range: true });
    expect(Number(call.body.to) - Number(call.body.from)).toBe(6 * 3600_000);
    expect(out).toContain('job="api"');
  });
  it('rejects wrong datasource type', async () => {
    await expect(promQuery.run({ datasource_uid: 'loki', expr: 'up' }, ctxWith(fakeHttp(() => ({}))))).rejects.toThrow(/needs prometheus/);
  });
  it('surfaces datasource query errors', async () => {
    const http = fakeHttp(() => ({ results: { A: { error: 'parse error: unexpected }' } } }));
    await expect(promQuery.run({ datasource_uid: 'mimir', expr: 'up{' }, ctxWith(http))).rejects.toThrow(/parse error/);
  });
  it('query_loki returns log lines for log queries', async () => {
    const http = fakeHttp(() => logsResponse([{ t: NOW, line: 'ERROR boom', labels: { app: 'checkout' } }]));
    const out = await lokiQuery.run({ datasource_uid: 'loki', expr: '{app="checkout"} |= "ERROR"' }, ctxWith(http));
    expect(http.calls[0].body.queries[0]).toMatchObject({ queryType: 'range', maxLines: 50, direction: 'backward' });
    expect(out).toContain('ERROR boom');
  });
  it('prometheus_metric_names filters via resource API', async () => {
    const http = fakeHttp(() => ({ data: ['http_requests_total', 'go_goroutines', 'http_request_duration_seconds_bucket'] }));
    const out = await promMetricNames.run({ datasource_uid: 'mimir', filter: '^http' }, ctxWith(http));
    expect(http.calls[0].url).toBe('/api/datasources/uid/mimir/resources/api/v1/label/__name__/values');
    expect(out).toContain('http_requests_total');
    expect(out).not.toContain('go_goroutines');
  });
  it('get_trace finds error and slow spans', async () => {
    const fields = ['traceID', 'spanID', 'parentSpanID', 'operationName', 'serviceName', 'startTime', 'duration', 'statusCode', 'statusMessage', 'tags'];
    const rows = [
      ['t', 's1', '', 'GET /checkout', 'checkout', 1000, 1500, 0, '', []],
      ['t', 's2', 's1', 'charge', 'payments', 1010, 1400, 2, 'card processor timeout', [{ key: 'http.status_code', value: 504 }]],
    ];
    const http = fakeHttp(() => ({
      results: { A: { frames: [{ schema: { fields: fields.map((name) => ({ name })) }, data: { values: fields.map((_, i) => rows.map((r) => r[i])) } }] } },
    }));
    const out = await tempoGetTrace.run({ datasource_uid: 'tempo', trace_id: 'abc' }, ctxWith(http));
    expect(out).toContain('2 spans');
    expect(out).toMatch(/Error spans \(1\)/);
    expect(out).toContain('card processor timeout');
    expect(out).toContain('http.status_code=504');
  });
});

describe('grafana object tools', () => {
  const dashboard = {
    dashboard: {
      uid: 'd1',
      title: 'Svc',
      templating: { list: [{ name: 'ns', type: 'query', current: { value: 'prod' } }, { name: 'pod', type: 'query', current: { value: ['$__all'] } }] },
      panels: [
        { id: 1, type: 'row', panels: [] },
        { id: 2, type: 'timeseries', title: 'RPS', datasource: { uid: 'mimir' }, targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total{namespace="$ns",pod=~"${pod}"}[5m]))' }] },
      ],
    },
  };
  it('interpolates dashboard variables', () => {
    expect(interpolateVars('a{ns="$ns",p=~"${pod}",x="[[ns]]"}', dashboard.dashboard.templating as any)).toBe('a{ns="prod",p=~".*",x="prod"}');
    expect(interpolateVars('$ns', dashboard.dashboard.templating as any, { ns: 'staging' })).toBe('staging');
  });
  it('run_panel_queries executes a panel with variables resolved', async () => {
    const http = fakeHttp((c) => (c.method === 'GET' ? dashboard : seriesResponse([{ labels: {}, values: [3, 4] }])));
    const out = await runPanelQueries.run({ dashboard_uid: 'd1', panel_id: 2 }, ctxWith(http));
    expect(http.calls[1].body.queries[0].expr).toBe('sum(rate(http_requests_total{namespace="prod",pod=~".*"}[5m]))');
    expect(out).toContain('Panel "RPS"');
  });
  it('list_alerts shows firing rules only by default', async () => {
    const http = fakeHttp(() => ({
      data: {
        groups: [
          {
            name: 'g',
            file: 'Platform',
            rules: [
              { type: 'alerting', name: 'HighErrors', uid: 'r1', state: 'firing', health: 'ok', query: 'x > 1', alerts: [{ state: 'Alerting', activeAt: '2026-11-09T11:00:00Z', value: '5', labels: { svc: 'checkout' } }] },
              { type: 'alerting', name: 'Quiet', uid: 'r2', state: 'inactive', health: 'ok', query: 'y' },
            ],
          },
        ],
      },
    }));
    const out = await listAlerts.run({}, ctxWith(http));
    expect(out).toContain('HighErrors');
    expect(out).not.toContain('Quiet');
  });
  it('get_annotations passes tags and range in ms', async () => {
    const http = fakeHttp(() => [{ time: NOW - 600_000, tags: ['deploy'], text: '<b>v2.3</b> rolled out' }]);
    const out = await getAnnotations.run({ tags: ['deploy'] }, ctxWith(http));
    expect(http.calls[0].params).toMatchObject({ tags: ['deploy'], from: NOW - 3600_000, to: NOW });
    expect(out).toContain('v2.3 rolled out');
  });
});

/** A scripted model: returns queued responses and records requests. */
function scriptedModel(responses: Array<Partial<MessagesResponse>>) {
  const requests: MessagesRequest[] = [];
  const call = async (req: MessagesRequest) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    const r = responses.shift();
    if (!r) {
      throw new Error('no more scripted responses');
    }
    return { id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [], ...r } as MessagesResponse;
  };
  return { call, requests };
}

describe('agent loop', () => {
  it('runs parallel tools, returns tool_results, then finishes', async () => {
    const http = fakeHttp((c) => (c.url === '/api/ds/query' ? seriesResponse([{ labels: { svc: 'a' }, values: [1] }]) : []));
    const { call, requests } = scriptedModel([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 't1', name: 'query_prometheus', input: { datasource_uid: 'mimir', expr: 'up' } },
          { type: 'tool_use', id: 't2', name: 'get_annotations', input: {} },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good.' }] },
    ]);
    const events: AgentEvent[] = [];
    const msgs = await runAgent({
      call,
      tools: buildToolset('chat', () => undefined),
      system: 'sys',
      messages: [{ role: 'user', content: 'how is it?' }],
      ctx: ctxWith(http),
      onEvent: (e) => events.push(e),
      maxSteps: 5,
    });
    expect(requests).toHaveLength(2);
    const results = (requests[1].messages[2].content as any[]).filter((b) => b.type === 'tool_result');
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    expect(events.filter((e) => e.kind === 'tool_end')).toHaveLength(2);
    expect(events.some((e) => e.kind === 'assistant_text' && e.text === 'All good.')).toBe(true);
    expect(msgs[msgs.length - 1].role).toBe('assistant');
    // prompt caching breakpoints on system and last tool
    expect((requests[0].system as any)[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(requests[0].tools!.slice(-1)[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('turns tool exceptions into is_error results instead of crashing', async () => {
    const { call, requests } = scriptedModel([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'query_prometheus', input: { datasource_uid: 'nope', expr: 'up' } }] },
      { content: [{ type: 'text', text: 'Datasource missing.' }] },
    ]);
    await runAgent({ call, tools: buildToolset('chat', () => undefined), system: 's', messages: [{ role: 'user', content: 'q' }], ctx: ctxWith(fakeHttp(() => ({}))), onEvent: () => undefined, maxSteps: 5 });
    const r = (requests[1].messages[2].content as any[])[0];
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/not found/);
  });

  it('enforces the step budget with a final no-tools call', async () => {
    const loop = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'list_datasources', input: {} }] } as any;
    const { call, requests } = scriptedModel([loop, { ...loop, content: [{ ...loop.content[0], id: 'y' }] }, { content: [{ type: 'text', text: 'final' }] }]);
    await runAgent({ call, tools: buildToolset('chat', () => undefined), system: 's', messages: [{ role: 'user', content: 'q' }], ctx: ctxWith(fakeHttp(() => ({}))), onEvent: () => undefined, maxSteps: 2 });
    expect(requests).toHaveLength(3);
    expect((requests[2] as any).tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(requests[2].messages.slice(-1))).toContain('Tool budget');
  });

  it('records findings in investigate mode', async () => {
    const found: any[] = [];
    const { call } = scriptedModel([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'f', name: 'record_finding', input: { title: 'Deploy at 11:02', detail: 'errors began 2m later', severity: 'high' } }] },
      { content: [{ type: 'text', text: '## Summary' }] },
    ]);
    await runAgent({
      call,
      tools: buildToolset('investigate', () => undefined),
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      ctx: ctxWith(fakeHttp(() => ({})), { recordFinding: (f) => found.push(f) }),
      onEvent: () => undefined,
      maxSteps: 5,
    });
    expect(found[0]).toMatchObject({ title: 'Deploy at 11:02', severity: 'high' });
  });

  it('stops promptly when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { call, requests } = scriptedModel([{ content: [] }]);
    const events: AgentEvent[] = [];
    await runAgent({ call, tools: [], system: 's', messages: [{ role: 'user', content: 'q' }], ctx: ctxWith(fakeHttp(() => ({})), { signal: ac.signal }), onEvent: (e) => events.push(e), maxSteps: 3 });
    expect(requests).toHaveLength(0);
    expect(events).toContainEqual({ kind: 'done', stopReason: 'aborted', steps: 0 });
  });

  it('compacts old tool results but keeps recent ones', () => {
    const big = 'x'.repeat(5000);
    const msgs: Message[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'n', input: {} }] });
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] });
    }
    compact(msgs, 15_000);
    expect((msgs[1].content as any[])[0].content).toMatch(/elided/);
    expect((msgs[11].content as any[])[0].content).toBe(big);
  });

  it('only marks one message cache breakpoint', () => {
    const req = buildRequest('s', [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'text', text: 'c' }] }], []);
    expect(JSON.stringify(req.messages).match(/cache_control/g)).toHaveLength(1);
  });
});

describe('prompt and report', () => {
  it('includes datasource inventory, time and investigation method', () => {
    const p = buildSystemPrompt({ mode: 'investigate', now: NOW, range: { from: NOW - 3600_000, to: NOW }, datasources: DATASOURCES, user: { login: 'anirudh' } });
    expect(p).toContain('uid=mimir');
    expect(p).toContain('2026-11-09T12:00:00Z');
    expect(p).toContain('## Root cause analysis');
    expect(buildSystemPrompt({ mode: 'chat', now: NOW, range: { from: 0, to: 1 }, datasources: [] })).not.toContain('## Root cause analysis');
  });
  it('builds a markdown report with findings sorted by severity', () => {
    const md = buildReport({
      title: 'Investigation: latency',
      question: 'why slow',
      range: { from: NOW - 3600_000, to: NOW },
      finalAnswer: '## Summary\nDB pool exhausted',
      findings: [
        { title: 'minor', detail: 'd', severity: 'low', at: 1 },
        { title: 'pool', detail: 'd', severity: 'critical', at: 2, evidence: 'q' },
      ],
      queries: [{ label: 'PromQL: up', ok: true }],
      generatedAt: NOW,
    });
    expect(md.indexOf('pool')).toBeLessThan(md.indexOf('minor'));
    expect(md).toContain('`PromQL: up`');
  });
});
