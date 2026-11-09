// Read-only tools for metrics (Prometheus/Mimir), logs (Loki) and traces (Tempo).

import { ToolDefinition } from '../types';
import { autoStepSeconds, iso, parseDurationSeconds, resolveRange } from '../time';
import { clip, framesOf, isLogFrame, summarizeLogs, summarizeTable, summarizeTimeSeries } from '../frames';
import { dsQuery, dsResource, findDataSource, LOKI_TYPES, PROM_TYPES, TEMPO_TYPES } from '../grafana';

const timeProps = {
  start: { type: 'string', description: 'Start: relative (now-1h), RFC3339, or epoch. Defaults to the conversation time range.' },
  end: { type: 'string', description: 'End: relative (now), RFC3339, or epoch. Defaults to the conversation time range.' },
};

export const listDataSources: ToolDefinition = {
  schema: {
    name: 'list_datasources',
    description:
      'List the datasources you can query (uid, name, type). Prometheus-type datasources include Mimir/Cortex/Thanos. Call this first when you do not yet know datasource UIDs.',
    input_schema: {
      type: 'object',
      properties: { type: { type: 'string', description: 'Optional type filter, e.g. prometheus, loki, tempo, pyroscope' } },
    },
  },
  describe: (i) => `List datasources${i.type ? ` (${i.type})` : ''}`,
  run: async (input, ctx) => {
    const list = ctx
      .listDataSources()
      .filter((d) => !input.type || d.type === input.type)
      .map((d) => `${d.uid} | ${d.name} | ${d.type}${d.isDefault ? ' | default' : ''}`);
    return list.length ? `uid | name | type\n${list.join('\n')}` : 'No matching datasources.';
  },
};

export const promQuery: ToolDefinition = {
  schema: {
    name: 'query_prometheus',
    description:
      'Run a PromQL query against a Prometheus/Mimir datasource. Returns per-series stats (min/max/avg/last, peak time) and downsampled samples. Use range queries to see trends, instant=true for a current snapshot. Prefer aggregations (sum by, topk) over raw high-cardinality selectors.',
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        expr: { type: 'string', description: 'PromQL expression' },
        instant: { type: 'boolean', description: 'Evaluate once at end time instead of over the range' },
        step: { type: 'string', description: 'Range step e.g. 30s, 1m, 5m. Auto if omitted.' },
        ...timeProps,
      },
      required: ['datasource_uid', 'expr'],
    },
  },
  describe: (i) => `PromQL: ${i.expr}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, PROM_TYPES);
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const step = parseDurationSeconds(input.step) ?? autoStepSeconds(range);
    const resp = await dsQuery(
      ctx,
      ds,
      {
        expr: input.expr,
        instant: !!input.instant,
        range: !input.instant,
        interval: `${step}s`,
        intervalMs: step * 1000,
        maxDataPoints: Math.ceil((range.to - range.from) / 1000 / step),
        format: 'time_series',
      },
      range
    );
    const header = `Range ${iso(range.from)} → ${iso(range.to)}, step ${step}s\n`;
    return clip(header + summarizeTimeSeries(framesOf(resp), { samples: input.instant ? 1 : 12 }));
  },
};

export const promMetricNames: ToolDefinition = {
  schema: {
    name: 'prometheus_metric_names',
    description:
      'Discover metric names in a Prometheus/Mimir datasource. Filter with a case-insensitive substring/regex (e.g. "http_request", "checkout.*latency") so you query real metric names instead of guessing.',
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        filter: { type: 'string', description: 'Regex/substring to match metric names' },
        limit: { type: 'number', description: 'Max names to return (default 150)' },
      },
      required: ['datasource_uid'],
    },
  },
  describe: (i) => `Find metrics${i.filter ? ` matching /${i.filter}/` : ''}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, PROM_TYPES);
    const resp = await dsResource<{ data?: string[] }>(ctx, ds, 'api/v1/label/__name__/values');
    let names = resp?.data ?? [];
    if (input.filter) {
      const re = new RegExp(input.filter, 'i');
      names = names.filter((n) => re.test(n));
    }
    const limit = Math.min(Number(input.limit) || 150, 500);
    return names.length
      ? `${names.length} metrics${names.length > limit ? ` (showing ${limit})` : ''}:\n${names.slice(0, limit).join('\n')}`
      : 'No metric names matched.';
  },
};

export const promLabels: ToolDefinition = {
  schema: {
    name: 'prometheus_labels',
    description:
      'Discover label names, or the values of one label, in a Prometheus/Mimir datasource, optionally restricted to series matching a selector (e.g. {__name__="http_requests_total"} or up{namespace="prod"}).',
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        label: { type: 'string', description: 'If set, return values of this label; otherwise list label names' },
        match: { type: 'string', description: 'Series selector to scope results' },
        ...timeProps,
      },
      required: ['datasource_uid'],
    },
  },
  describe: (i) => (i.label ? `Label values: ${i.label}${i.match ? ` for ${i.match}` : ''}` : `Label names${i.match ? ` for ${i.match}` : ''}`),
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, PROM_TYPES);
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const params: Record<string, unknown> = { start: Math.floor(range.from / 1000), end: Math.floor(range.to / 1000) };
    if (input.match) {
      params['match[]'] = input.match;
    }
    const path = input.label ? `api/v1/label/${encodeURIComponent(input.label)}/values` : 'api/v1/labels';
    const resp = await dsResource<{ data?: string[] }>(ctx, ds, path, params);
    const vals = resp?.data ?? [];
    return vals.length ? `${vals.length} values:\n${vals.slice(0, 300).join('\n')}${vals.length > 300 ? '\n…' : ''}` : 'None found.';
  },
};

export const lokiQuery: ToolDefinition = {
  schema: {
    name: 'query_loki',
    description:
      'Run a LogQL query against a Loki datasource. Log queries ({app="x"} |= "error") return the newest lines; metric queries (sum by (level) (count_over_time({app="x"}[5m]))) return series stats. Start with metric queries to find where errors cluster, then pull lines from that window. Always include at least one label matcher.',
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        expr: { type: 'string', description: 'LogQL expression' },
        limit: { type: 'number', description: 'Max log lines (default 50, max 300)' },
        direction: { type: 'string', enum: ['backward', 'forward'], description: 'backward = newest first (default)' },
        step: { type: 'string', description: 'Step for metric queries e.g. 1m' },
        ...timeProps,
      },
      required: ['datasource_uid', 'expr'],
    },
  },
  describe: (i) => `LogQL: ${i.expr}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, LOKI_TYPES);
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 300);
    const step = parseDurationSeconds(input.step) ?? autoStepSeconds(range);
    const resp = await dsQuery(
      ctx,
      ds,
      {
        expr: input.expr,
        queryType: 'range',
        maxLines: limit,
        direction: input.direction === 'forward' ? 'forward' : 'backward',
        intervalMs: step * 1000,
        maxDataPoints: Math.ceil((range.to - range.from) / 1000 / step),
      },
      range
    );
    const frames = framesOf(resp);
    const header = `Range ${iso(range.from)} → ${iso(range.to)}\n`;
    if (frames.some(isLogFrame)) {
      return clip(header + summarizeLogs(frames.filter(isLogFrame), limit));
    }
    return clip(header + summarizeTimeSeries(frames));
  },
};

export const lokiLabels: ToolDefinition = {
  schema: {
    name: 'loki_labels',
    description:
      'Discover Loki stream label names, or values of one label (e.g. service_name, namespace, app, level), optionally scoped by a stream selector. Use before writing LogQL so selectors match real streams.',
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        label: { type: 'string', description: 'If set, list values for this label' },
        selector: { type: 'string', description: 'Stream selector to scope values, e.g. {namespace="prod"}' },
        ...timeProps,
      },
      required: ['datasource_uid'],
    },
  },
  describe: (i) => (i.label ? `Loki values: ${i.label}` : 'Loki label names'),
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, LOKI_TYPES);
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const params: Record<string, unknown> = { start: range.from * 1e6, end: range.to * 1e6 };
    if (input.selector) {
      params.query = input.selector;
    }
    const path = input.label ? `label/${encodeURIComponent(input.label)}/values` : 'labels';
    const resp = await dsResource<{ data?: string[] }>(ctx, ds, path, params);
    const vals = resp?.data ?? [];
    return vals.length ? `${vals.length} values:\n${vals.slice(0, 300).join('\n')}` : 'None found.';
  },
};

export const lokiPatterns: ToolDefinition = {
  schema: {
    name: 'loki_patterns',
    description:
      'Get the most common log line patterns for a stream selector (requires Loki pattern ingester). Excellent for quickly seeing what a service is logging and spotting new error shapes without reading thousands of lines.',
    input_schema: {
      type: 'object',
      properties: { datasource_uid: { type: 'string' }, selector: { type: 'string', description: 'Stream selector, e.g. {service_name="checkout"}' }, ...timeProps },
      required: ['datasource_uid', 'selector'],
    },
  },
  describe: (i) => `Log patterns: ${i.selector}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, LOKI_TYPES);
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const resp = await dsResource<{ data?: Array<{ pattern: string; samples: Array<[number, number]>; level?: string }> }>(ctx, ds, 'patterns', {
      query: input.selector,
      start: new Date(range.from).toISOString(),
      end: new Date(range.to).toISOString(),
    });
    const pats = (resp?.data ?? [])
      .map((p) => ({ p: p.pattern, level: p.level, n: (p.samples ?? []).reduce((a, s) => a + Number(s[1] ?? 0), 0) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 40);
    return pats.length
      ? pats.map((x) => `${x.n}× ${x.level ? `[${x.level}] ` : ''}${x.p.slice(0, 300)}`).join('\n')
      : 'No patterns returned (the pattern ingester may be disabled). Fall back to count_over_time and log line queries.';
  },
};

export const tempoSearch: ToolDefinition = {
  schema: {
    name: 'search_traces',
    description:
      'Search traces in Tempo with TraceQL, e.g. {resource.service.name="checkout" && status=error}, {duration > 2s}, { span.http.status_code >= 500 }. Returns matching traces (trace ID, root service/operation, start, duration).',
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        traceql: { type: 'string' },
        limit: { type: 'number', description: 'Max traces (default 20, max 50)' },
        ...timeProps,
      },
      required: ['datasource_uid', 'traceql'],
    },
  },
  describe: (i) => `TraceQL: ${i.traceql}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, TEMPO_TYPES);
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
    const resp = await dsQuery(ctx, ds, { queryType: 'traceql', query: input.traceql, limit, tableType: 'traces', spss: 3 }, range);
    return clip(summarizeTable(framesOf(resp), limit));
  },
};

export const tempoGetTrace: ToolDefinition = {
  schema: {
    name: 'get_trace',
    description:
      'Fetch one trace by ID from Tempo and summarise it: services involved, span count, error spans with status messages, and the slowest spans. Use trace IDs found in logs or search_traces.',
    input_schema: {
      type: 'object',
      properties: { datasource_uid: { type: 'string' }, trace_id: { type: 'string' }, ...timeProps },
      required: ['datasource_uid', 'trace_id'],
    },
  },
  describe: (i) => `Trace ${String(i.trace_id).slice(0, 16)}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, TEMPO_TYPES);
    // Trace lookup ignores time in most setups; use a wide window so older traces resolve.
    const range = resolveRange({ start: input.start ?? 'now-7d', end: input.end ?? 'now' }, ctx.timeRange, ctx.now());
    const resp = await dsQuery(ctx, ds, { queryType: 'traceql', query: String(input.trace_id).trim() }, range);
    const frames = framesOf(resp);
    const f = frames.find((x) => (x.schema?.fields ?? []).some((fl) => fl.name === 'spanID')) ?? frames[0];
    if (!f) {
      return 'Trace not found.';
    }
    const fields = f.schema?.fields ?? [];
    const col = (n: string) => f.data?.values[fields.findIndex((x) => x.name === n)] ?? [];
    const spanIds = col('spanID') as string[];
    const svc = col('serviceName') as string[];
    const op = col('operationName') as string[];
    const dur = col('duration') as number[];
    const start = col('startTime') as number[];
    const status = col('statusCode') as number[];
    const statusMsg = col('statusMessage') as string[];
    const tags = col('tags') as Array<Array<{ key: string; value: unknown }>>;
    const n = spanIds.length;
    if (!n) {
      return summarizeTable(frames, 30);
    }
    const t0 = Math.min(...start.filter((x) => typeof x === 'number'));
    const services = new Map<string, number>();
    svc.forEach((s) => services.set(s, (services.get(s) ?? 0) + 1));
    const idx = [...Array(n).keys()];
    const isErr = (i: number) =>
      status[i] === 2 || (tags[i] ?? []).some((t) => (t.key === 'error' && t.value === true) || (t.key === 'otel.status_code' && t.value === 'ERROR'));
    const errs = idx.filter(isErr);
    const slow = [...idx].sort((a, b) => (dur[b] ?? 0) - (dur[a] ?? 0)).slice(0, 12);
    const interesting = (i: number) =>
      (tags[i] ?? [])
        .filter((t) => /^(http\.|db\.|rpc\.|net\.peer|server\.address|error|exception|messaging\.)/.test(t.key))
        .slice(0, 6)
        .map((t) => `${t.key}=${String(t.value).slice(0, 80)}`)
        .join(' ');
    const line = (i: number) =>
      `  ${svc[i]} :: ${op[i]} dur=${Math.round(dur[i] ?? 0)}ms start=+${Math.round((start[i] ?? t0) - t0)}ms${isErr(i) ? ' ERROR' : ''}${statusMsg[i] ? ` msg="${String(statusMsg[i]).slice(0, 160)}"` : ''} ${interesting(i)}`;
    return clip(
      [
        `Trace ${input.trace_id}: ${n} spans, total ≈ ${Math.round(Math.max(...idx.map((i) => (start[i] ?? t0) - t0 + (dur[i] ?? 0))))}ms`,
        `Services: ${[...services.entries()].map(([s, c]) => `${s}(${c})`).join(', ')}`,
        `Error spans (${errs.length}):`,
        ...errs.slice(0, 15).map(line),
        'Slowest spans:',
        ...slow.map(line),
      ].join('\n')
    );
  },
};

export const tempoTags: ToolDefinition = {
  schema: {
    name: 'tempo_tag_values',
    description: 'List values for a TraceQL tag in Tempo (e.g. resource.service.name, span.http.route, name) to build accurate TraceQL.',
    input_schema: {
      type: 'object',
      properties: { datasource_uid: { type: 'string' }, tag: { type: 'string', description: 'Scoped tag, e.g. resource.service.name' } },
      required: ['datasource_uid', 'tag'],
    },
  },
  describe: (i) => `Tempo values: ${i.tag}`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, TEMPO_TYPES);
    const range = resolveRange({}, ctx.timeRange, ctx.now());
    const resp = await dsResource<{ tagValues?: Array<{ value: string } | string> }>(
      ctx,
      ds,
      `api/v2/search/tag/${encodeURIComponent(input.tag)}/values`,
      { start: Math.floor(range.from / 1000), end: Math.floor(range.to / 1000) }
    );
    const vals = (resp?.tagValues ?? []).map((v) => (typeof v === 'string' ? v : v.value));
    return vals.length ? vals.slice(0, 300).join('\n') : 'No values found.';
  },
};

export const observabilityTools = [
  listDataSources,
  promMetricNames,
  promLabels,
  promQuery,
  lokiLabels,
  lokiQuery,
  lokiPatterns,
  tempoTags,
  tempoSearch,
  tempoGetTrace,
];
