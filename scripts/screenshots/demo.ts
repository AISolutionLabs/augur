// Scripted demo backend: a fictional "checkout" latency incident caused by a deploy that shrank the
// database connection pool. Both the Grafana API responses and the model's turns are scripted, so the
// screenshots show the real Augur UI deterministically. Nothing here is real customer data.

const NOW = Date.now();
const MIN = 60_000;
const SCENE = (window as any).__SCENE__ as 'investigation' | 'actions';

function series(labels: Record<string, string>, f: (minAgo: number) => number, points = 60) {
  const times: number[] = [];
  const values: number[] = [];
  for (let i = points; i >= 0; i--) {
    times.push(NOW - i * MIN);
    values.push(Math.round(f(i) * 1000) / 1000);
  }
  return { schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels }] }, data: { values: [times, values] } };
}

const afterDeploy = (m: number) => m < 36;
function frameFor(q: any) {
  const expr = String(q.expr ?? q.query ?? '');
  if (q.queryType === 'traceql') {
    const ids = ['4bf92f3577b34da6', 'a3ce929d0e0e4736', '0af7651916cd43dd', '6e0c63257de34c92', 'b7ad6b7169203331'];
    return {
      schema: {
        name: 'Traces',
        fields: [
          { name: 'traceID', type: 'string' },
          { name: 'startTime', type: 'time' },
          { name: 'traceService', type: 'string' },
          { name: 'traceName', type: 'string' },
          { name: 'traceDuration', type: 'number' },
        ],
      },
      data: { values: [ids, ids.map((_, i) => NOW - (5 + i * 6) * MIN), ids.map(() => 'checkout'), ids.map(() => 'POST /api/checkout'), [5210, 5034, 4987, 5121, 5008]] },
    };
  }
  if (q.datasource?.type === 'loki' && !/^\s*(sum|count|rate)/.test(expr)) {
    const lines: Array<[number, string]> = [];
    for (let i = 0; i < 30; i++) {
      lines.push([NOW - i * 70_000, `level=error msg="db: timeout acquiring connection from pool" pool=orders max_open=20 waited=${5000 + i}ms trace_id=${(0x4bf92f3577b34da6n + BigInt(i)).toString(16)}`]);
    }
    lines.push([NOW - 33 * MIN, 'level=info msg="config loaded" db.max_open_conns=20 version=v2.4.0']);
    return {
      schema: { meta: { type: 'log-lines' }, fields: [{ name: 'labels', type: 'other' }, { name: 'Time', type: 'time' }, { name: 'Line', type: 'string' }] },
      data: { values: [lines.map(() => ({ service_name: 'checkout', namespace: 'shop' })), lines.map((l) => l[0]), lines.map((l) => l[1])] },
    };
  }
  if (/pool|db_client_connections/.test(expr)) {
    return series({ pool: 'orders', service_name: 'checkout' }, (m) => (afterDeploy(m) ? 20 : 11 + Math.sin(m) * 2));
  }
  if (/histogram_quantile|duration/.test(expr)) {
    return series({ service_name: 'checkout' }, (m) => (afterDeploy(m) ? 4.6 + Math.sin(m / 3) * 0.4 : 0.42 + Math.sin(m) * 0.05));
  }
  if (/5\.\.|error|status/.test(expr)) {
    return series({ service_name: 'checkout' }, (m) => (afterDeploy(m) ? 0.071 + Math.sin(m / 2) * 0.01 : 0.002));
  }
  return series({ service_name: 'checkout' }, (m) => 140 + Math.sin(m / 4) * 12);
}

function dsQuery(body: any) {
  const results: Record<string, unknown> = {};
  for (const q of body.queries) {
    results[q.refId] = { frames: [frameFor(q)] };
  }
  return { results };
}

// ---- scripted model ------------------------------------------------------------

const SLOW = (window as any).__SLOW__ ? 7 : 1;
const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms * SLOW));
const msg = (content: any[], stop = 'end_turn') => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stop, usage: { input_tokens: 4200, output_tokens: 610, cache_read_input_tokens: 9800 } });
const tool = (id: string, name: string, input: any) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t });

let leadStep = 0;

function subAgent(req: any) {
  const objective = JSON.stringify(req.messages[0]);
  const hasResult = req.messages.length > 1;
  const kind = objective.includes('logs') ? 'logs' : objective.includes('traces') ? 'traces' : 'metrics';
  if (!hasResult) {
    if (kind === 'metrics') {
      return msg([tool(`m-${kind}`, 'query_prometheus', { datasource_uid: 'mimir', expr: 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[5m])))', start: 'now-1h' })], 'tool_use');
    }
    if (kind === 'logs') {
      return msg([tool(`m-${kind}`, 'query_loki', { datasource_uid: 'loki', expr: '{service_name="checkout"} |= "error"', limit: 50 })], 'tool_use');
    }
    return msg([tool(`m-${kind}`, 'search_traces', { datasource_uid: 'tempo', traceql: '{resource.service.name="checkout" && duration > 2s}' })], 'tool_use');
  }
  const briefs: Record<string, string> = {
    metrics: 'FINDINGS: checkout p99 rose from 0.42s to 4.6s at 11:24Z and stayed there; RPS flat (~140/s); 5xx ratio 0.2% → 7.1%.\nANOMALIES: step change, not gradual.\nLEADS: correlate with deploy annotations at 11:22Z.',
    logs: 'FINDINGS: 30 near-identical errors "timeout acquiring connection from pool" (pool=orders, max_open=20) since 11:24Z; config log at 11:27Z shows db.max_open_conns=20 on v2.4.0.\nLEADS: trace_id 4bf92f3577b34da6.',
    traces: 'FINDINGS: slow traces (≈5.0s) all spend >4.8s in span "db.acquire" before the orders INSERT; payment-provider spans are 120-180ms (normal).\nNOT FOUND: no downstream dependency errors.',
  };
  return msg([text(briefs[kind])]);
}

function lead() {
  const steps = [
    () =>
      msg(
        [
          text('Scoping: checking firing alerts and recent changes, and fanning out to specialists for metrics, logs and traces.'),
          tool('l1', 'list_alerts', {}),
          tool('l2', 'get_annotations', { tags: ['deploy'], start: 'now-2h' }),
          tool('l3', 'delegate', {
            tasks: [
              { name: 'metrics', objective: 'Golden signals for checkout over the last hour vs 1 day earlier; find onset time.' },
              { name: 'logs', objective: 'Error logs for checkout since the onset; extract error signatures and trace ids.' },
              { name: 'traces', objective: 'Slow checkout traces (>2s): which span dominates?' },
            ],
          }),
        ],
        'tool_use'
      ),
    () =>
      msg(
        [
          tool('l4', 'record_finding', { title: 'p99 latency 0.42s → 4.6s at 11:24Z', detail: 'Step change two minutes after the v2.4.0 deploy; traffic unchanged.', severity: 'high', evidence: 'histogram_quantile(0.99, … checkout …)' }),
          tool('l5', 'record_finding', { title: 'Connection-pool timeouts in checkout', detail: '"timeout acquiring connection from pool" (max_open=20) on every slow request.', severity: 'high', evidence: '{service_name="checkout"} |= "error"' }),
          tool('l6', 'update_hypothesis', { key: 'pool', statement: 'v2.4.0 reduced db.max_open_conns 50→20, exhausting the orders pool', status: 'supported', confidence: 0.75, evidence: 'onset 2 min after deploy; pool timeouts; db.acquire dominates traces' }),
          tool('l7', 'update_hypothesis', { key: 'provider', statement: 'Payment provider latency regression', status: 'open', confidence: 0.2, evidence: 'not yet checked' }),
        ],
        'tool_use'
      ),
    () => msg([text('The evidence points at the connection pool.')]),
    () =>
      msg(
        [
          tool('l8', 'query_prometheus', { datasource_uid: 'mimir', expr: 'max by (pool) (db_client_connections_usage{service_name="checkout"})', start: 'now-2h' }),
          tool('l9', 'update_hypothesis', { key: 'provider', statement: 'Payment provider latency regression', status: 'refuted', confidence: 0.05, evidence: 'provider spans 120-180ms, unchanged', challenged: true }),
          tool('l10', 'update_hypothesis', { key: 'pool', statement: 'v2.4.0 reduced db.max_open_conns 50→20, exhausting the orders pool', status: 'confirmed', confidence: 0.92, evidence: 'pool pinned at 20/20 from 11:24Z; peers on v2.3.9 unaffected', challenged: true }),
        ],
        'tool_use'
      ),
    () =>
      msg([
        text(`## Summary
The checkout slowdown was caused by the **v2.4.0** deploy, which lowered \`db.max_open_conns\` from 50 to 20. The orders connection pool has been pinned at its limit since **11:24Z**, so requests queue for ~5s waiting for a connection. **Confidence: high**: the timing, logs, traces and pool metrics all agree, and the alternative (payment provider) was ruled out.

## Timeline (UTC)
- **11:22** checkout v2.4.0 rolled out (deploy annotation)
- **11:24** p99 0.42s → 4.6s; 5xx 0.2% → 7.1%; pool usage 20/20
- **11:27** \`CheckoutHighLatency\` firing

## Evidence
1. p99 latency step change: \`histogram_quantile(0.99, …{service_name="checkout"}…)\`, [open in Explore](/explore)
2. Pool exhausted: \`max by (pool) (db_client_connections_usage{service_name="checkout"})\` = 20/20
3. 30× \`timeout acquiring connection from pool\` in checkout logs; slow traces spend >4.8s in \`db.acquire\`

## Recommended actions
- **Now:** roll back to v2.3.9, or set \`DB_MAX_OPEN_CONNS=50\`.
- **Follow-up:** alert on pool saturation (I can draft it), and add a config check in CI.`),
      ]),
  ];
  const s = steps[Math.min(leadStep, steps.length - 1)];
  leadStep++;
  return s();
}

let actionStep = 0;
function actions() {
  actionStep++;
  if (actionStep === 1) {
    return msg(
      [
        text('Drafting the dashboard, an alert for pool saturation, and a silence while the rollback finishes.'),
        tool('a1', 'draft_dashboard', {
          title: 'Checkout: service health',
          folder_uid: 'checkout',
          tags: ['checkout', 'red'],
          variables: [{ name: 'namespace', type: 'query', datasource_uid: 'mimir', query: 'label_values(http_server_request_duration_seconds_count{service_name="checkout"}, namespace)' }],
          panels: [
            { title: 'Requests/s', type: 'stat', datasource_uid: 'mimir', unit: 'reqps', queries: [{ expr: 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout",namespace="$namespace"}[$__rate_interval]))' }] },
            { title: 'Error %', type: 'stat', datasource_uid: 'mimir', unit: 'percentunit', queries: [{ expr: 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout",status=~"5.."}[$__rate_interval])) / sum(rate(http_server_request_duration_seconds_count{service_name="checkout"}[$__rate_interval]))' }] },
            { title: 'p99 latency', type: 'stat', datasource_uid: 'mimir', unit: 's', queries: [{ expr: 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[$__rate_interval])))' }] },
            { title: 'DB pool usage', type: 'gauge', datasource_uid: 'mimir', max: 50, queries: [{ expr: 'max(db_client_connections_usage{service_name="checkout"})' }] },
            { title: 'Latency p50/p99', type: 'timeseries', datasource_uid: 'mimir', unit: 's', row: 'Latency', queries: [{ expr: 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout"}[$__rate_interval])))', legend: 'p99' }] },
            { title: 'Error logs', type: 'logs', datasource_uid: 'loki', row: 'Logs', queries: [{ expr: '{service_name="checkout"} |= "error"' }] },
            { title: 'Slow traces', type: 'traces', datasource_uid: 'tempo', row: 'Traces', queries: [{ traceql: '{resource.service.name="checkout" && duration > 2s}' }] },
          ],
        }),
        tool('a2', 'draft_alert_rule', {
          title: 'Checkout DB pool saturated',
          folder_uid: 'checkout',
          group: 'checkout-capacity',
          datasource_uid: 'mimir',
          expr: 'max(db_client_connections_usage{service_name="checkout"}) / max(db_client_connections_max{service_name="checkout"})',
          operator: 'gt',
          threshold: 0.9,
          for: '5m',
          labels: { severity: 'page', team: 'checkout' },
          summary: 'checkout DB connection pool above 90% for 5m',
        }),
        tool('a3', 'draft_silence', { matchers: [{ name: 'alertname', value: 'CheckoutHighLatency' }], duration: '1h', comment: 'Rollback of checkout v2.4.0 in progress (investigation 11:40Z)' }),
      ],
      'tool_use'
    );
  }
  return msg([text('Three proposals are ready for you to review. Nothing has been created yet: choose a folder and click **Save**, **Create alert rule** or **Create silence**.')]);
}

export function handle(opts: { url: string; method: string; data?: any; params?: any }): any {
  const { url, data } = opts;
  if (url.endsWith('/resources/config')) {
    return { defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5'], maxTokens: 8192, authMethod: 'oauth', mcpServers: [] };
  }
  if (url.endsWith('/resources/messages')) {
    const sys = JSON.stringify(data.system ?? '');
    const r = sys.includes('You are a specialist sub-agent working for a lead investigator') ? subAgent(data) : SCENE === 'actions' ? actions() : lead();
    return delay(r);
  }
  if (url.includes('/api/plugins/') && url.endsWith('/settings')) {
    return {
      jsonData: {
        skills: [
          { name: 'db-pool', title: 'DB connection pool exhaustion', description: 'Pool timeouts, slow queries waiting on connections', body: '…', enabled: true },
          { name: 'kafka-lag', title: 'Kafka consumer lag', description: 'Consumers falling behind', body: '…', enabled: true },
        ],
      },
    };
  }
  if (url === '/api/ds/query') {
    return delay(dsQuery(data), 60);
  }
  if (url === '/api/annotations') {
    return [{ time: NOW - 38 * MIN, tags: ['deploy', 'checkout'], text: 'checkout v2.4.0 rolled out: "tune db pool (max_open_conns 50→20)"' }];
  }
  if (url === '/api/prometheus/grafana/api/v1/rules') {
    return {
      data: {
        groups: [
          {
            name: 'checkout-slo',
            file: 'Checkout',
            rules: [
              { type: 'alerting', name: 'CheckoutHighLatency', uid: 'r-lat', state: 'firing', health: 'ok', query: 'p99 > 2s', annotations: { summary: 'checkout p99 above 2s' }, alerts: [{ state: 'Alerting', activeAt: new Date(NOW - 33 * MIN).toISOString(), value: '4.6', labels: { service_name: 'checkout', severity: 'page' } }] },
            ],
          },
        ],
      },
    };
  }
  if (url === '/api/search') {
    return opts.params?.type === 'dash-folder' ? [{ uid: 'checkout', title: 'Checkout' }, { uid: 'platform', title: 'Platform' }] : [];
  }
  if (url.endsWith('/api/v2/alerts')) {
    return [{ labels: { alertname: 'CheckoutHighLatency', service_name: 'checkout', severity: 'page' } }];
  }
  return [];
}
