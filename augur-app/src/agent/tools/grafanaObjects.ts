// Read-only tools over Grafana's own objects: dashboards, alerts, annotations.

import { ToolDefinition, ToolContext, DataSourceInfo } from '../types';
import { iso, resolveRange } from '../time';
import { clip, framesOf, isLogFrame, summarizeLogs, summarizeTable, summarizeTimeSeries } from '../frames';
import { errorMessage } from '../grafana';

interface SearchHit {
  uid: string;
  title: string;
  folderTitle?: string;
  tags?: string[];
  url?: string;
  type?: string;
}

export const searchDashboards: ToolDefinition = {
  schema: {
    name: 'search_dashboards',
    description:
      'Search dashboards by title text and/or tag. Existing dashboards encode what the team considers important for a service, including their best queries. Returns uid, title, folder, tags.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'number', description: 'Default 30' },
      },
    },
  },
  describe: (i) => `Search dashboards${i.query ? `: ${i.query}` : ''}${i.tag ? ` #${i.tag}` : ''}`,
  run: async (input, ctx) => {
    const hits = await ctx.http.get<SearchHit[]>(
      '/api/search',
      { type: 'dash-db', query: input.query ?? '', tag: input.tag, limit: Math.min(Number(input.limit) || 30, 100) },
      ctx.signal
    );
    if (!hits?.length) {
      return 'No dashboards found.';
    }
    return hits.map((h) => `${h.uid} | ${h.title} | folder: ${h.folderTitle ?? 'General'}${h.tags?.length ? ` | tags: ${h.tags.join(',')}` : ''}`).join('\n');
  },
};

interface Panel {
  id?: number;
  type?: string;
  title?: string;
  description?: string;
  datasource?: { uid?: string; type?: string } | string | null;
  targets?: Array<Record<string, any>>;
  panels?: Panel[];
  fieldConfig?: { defaults?: { unit?: string } };
  collapsed?: boolean;
}

interface DashboardModel {
  uid?: string;
  title?: string;
  description?: string;
  tags?: string[];
  panels?: Panel[];
  rows?: Array<{ panels?: Panel[] }>;
  templating?: { list?: Array<{ name: string; type: string; query?: any; current?: { value?: any; text?: any }; datasource?: any }> };
}

export function flattenPanels(dash: DashboardModel): Panel[] {
  const out: Panel[] = [];
  const walk = (ps?: Panel[]) =>
    (ps ?? []).forEach((p) => {
      if (p.type === 'row') {
        walk(p.panels);
      } else {
        out.push(p);
      }
    });
  walk(dash.panels);
  (dash.rows ?? []).forEach((r) => walk(r.panels));
  return out;
}

function targetText(t: Record<string, any>): string {
  return String(t.expr ?? t.query ?? t.rawSql ?? t.queryText ?? t.target ?? JSON.stringify(t).slice(0, 200));
}

export const getDashboard: ToolDefinition = {
  schema: {
    name: 'get_dashboard',
    description:
      'Get a dashboard summary: variables (with current values), and every panel with id, type, datasource and query expressions. Use this to reuse curated queries, or to understand what a dashboard is showing.',
    input_schema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] },
  },
  describe: (i) => `Read dashboard ${i.uid}`,
  run: async (input, ctx) => {
    const resp = await ctx.http.get<{ dashboard: DashboardModel; meta?: { folderTitle?: string; url?: string } }>(
      `/api/dashboards/uid/${encodeURIComponent(input.uid)}`,
      undefined,
      ctx.signal
    );
    const d = resp.dashboard;
    const lines = [`"${d.title}" (uid ${d.uid}) folder: ${resp.meta?.folderTitle ?? 'General'} tags: ${(d.tags ?? []).join(',')}`];
    if (d.description) {
      lines.push(`Description: ${d.description}`);
    }
    const vars = d.templating?.list ?? [];
    if (vars.length) {
      lines.push('Variables:');
      vars.forEach((v) =>
        lines.push(`  $${v.name} (${v.type}) current=${JSON.stringify(v.current?.value ?? v.current?.text ?? '')} query=${JSON.stringify(v.query ?? '').slice(0, 150)}`)
      );
    }
    lines.push('Panels:');
    for (const p of flattenPanels(d)) {
      const ds = typeof p.datasource === 'string' ? p.datasource : p.datasource?.uid ?? 'default';
      lines.push(`  [${p.id}] ${p.title || '(untitled)'} — ${p.type} ds=${ds}${p.fieldConfig?.defaults?.unit ? ` unit=${p.fieldConfig.defaults.unit}` : ''}`);
      (p.targets ?? []).forEach((t) => lines.push(`      ${t.refId ?? ''}: ${targetText(t).slice(0, 400)}`));
    }
    return clip(lines.join('\n'));
  },
};

/** Replaces $var, ${var}, ${var:fmt} and [[var]] with the dashboard's current values. */
export function interpolateVars(text: string, vars: DashboardModel['templating'], overrides: Record<string, string> = {}): string {
  let out = text;
  for (const v of vars?.list ?? []) {
    let value: string;
    if (overrides[v.name] !== undefined) {
      value = overrides[v.name];
    } else {
      const raw = v.current?.value;
      const arr = Array.isArray(raw) ? raw : [raw];
      value = arr.includes('$__all') ? '.*' : arr.filter((x) => x !== undefined && x !== null).join('|');
    }
    const name = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\$\\{${name}(?::[^}]*)?\\}|\\[\\[${name}\\]\\]|\\$${name}\\b`, 'g'), value);
  }
  return out;
}

function resolveDs(ref: any, vars: DashboardModel['templating'], all: DataSourceInfo[]): DataSourceInfo | undefined {
  if (!ref) {
    return all.find((d) => d.isDefault);
  }
  let key: string = typeof ref === 'string' ? ref : ref.uid;
  if (key && key.startsWith('$')) {
    key = interpolateVars(key, vars);
  }
  return all.find((d) => d.uid === key || d.name === key);
}

export const runPanelQueries: ToolDefinition = {
  schema: {
    name: 'run_panel_queries',
    description:
      "Execute the queries of an existing dashboard panel (template variables resolved to current values or your overrides) and summarise the result. The quickest way to reuse a team's curated query.",
    input_schema: {
      type: 'object',
      properties: {
        dashboard_uid: { type: 'string' },
        panel_id: { type: 'number' },
        variables: { type: 'object', description: 'Overrides for template variables, e.g. {"namespace":"prod"}', additionalProperties: { type: 'string' } },
        start: { type: 'string' },
        end: { type: 'string' },
      },
      required: ['dashboard_uid', 'panel_id'],
    },
  },
  describe: (i) => `Run panel ${i.panel_id} of ${i.dashboard_uid}`,
  run: async (input, ctx: ToolContext) => {
    const resp = await ctx.http.get<{ dashboard: DashboardModel }>(`/api/dashboards/uid/${encodeURIComponent(input.dashboard_uid)}`, undefined, ctx.signal);
    const d = resp.dashboard;
    const panel = flattenPanels(d).find((p) => p.id === Number(input.panel_id));
    if (!panel) {
      throw new Error(`panel ${input.panel_id} not found; call get_dashboard for panel ids`);
    }
    const all = ctx.listDataSources();
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const overrides = (input.variables ?? {}) as Record<string, string>;
    const queries = (panel.targets ?? [])
      .filter((t) => !t.hide)
      .map((t) => {
        const ds = resolveDs(t.datasource && (t.datasource.uid ?? t.datasource) !== '-- Mixed --' ? t.datasource : panel.datasource, d.templating, all);
        if (!ds) {
          return undefined;
        }
        const q: Record<string, any> = JSON.parse(interpolateVars(JSON.stringify(t), d.templating, overrides));
        return { ...q, datasource: { uid: ds.uid, type: ds.type }, maxDataPoints: 200, intervalMs: Math.max(15000, Math.floor((range.to - range.from) / 200)) };
      })
      .filter(Boolean);
    if (!queries.length) {
      throw new Error('panel has no runnable queries (datasource could not be resolved)');
    }
    const r = await ctx.http.post<any>('/api/ds/query', { queries, from: String(range.from), to: String(range.to) }, ctx.signal);
    const parts = [`Panel "${panel.title}" (${panel.type}) ${iso(range.from)} → ${iso(range.to)}`];
    for (const q of queries as any[]) {
      try {
        const frames = framesOf(r, q.refId ?? 'A');
        const body = frames.some(isLogFrame)
          ? summarizeLogs(frames.filter(isLogFrame), 40)
          : frames.some((f) => (f.schema?.fields ?? []).some((x) => x.type === 'time')) && frames.every((f) => (f.schema?.fields ?? []).some((x) => x.type === 'number'))
            ? summarizeTimeSeries(frames)
            : summarizeTable(frames, 25);
        parts.push(`Query ${q.refId}: ${targetText(q).slice(0, 300)}\n${body}`);
      } catch (e) {
        parts.push(`Query ${q.refId}: error ${errorMessage(e)}`);
      }
    }
    return clip(parts.join('\n\n'));
  },
};

export const listAlerts: ToolDefinition = {
  schema: {
    name: 'list_alerts',
    description:
      'List Grafana-managed alert rules and their current state, with firing/pending instances (labels, since when, value). Filter by state or a text match on rule name/labels.',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['firing', 'pending', 'inactive', 'any'], description: 'Default: firing and pending' },
        match: { type: 'string', description: 'Case-insensitive text to match rule name, group, folder or labels' },
      },
    },
  },
  describe: (i) => `Alerts (${i.state ?? 'firing+pending'})${i.match ? ` ~${i.match}` : ''}`,
  run: async (input, ctx) => {
    const resp = await ctx.http.get<any>('/api/prometheus/grafana/api/v1/rules', undefined, ctx.signal);
    const want = (s: string) => {
      const st = input.state ?? 'active';
      if (st === 'any') {
        return true;
      }
      if (st === 'active') {
        return s === 'firing' || s === 'pending';
      }
      return s === st;
    };
    const re = input.match ? new RegExp(input.match, 'i') : undefined;
    const lines: string[] = [];
    let total = 0;
    for (const g of resp?.data?.groups ?? []) {
      for (const r of g.rules ?? []) {
        if (r.type && r.type !== 'alerting') {
          continue;
        }
        const state = String(r.state ?? 'inactive').toLowerCase();
        const text = `${g.file} ${g.name} ${r.name} ${JSON.stringify(r.labels ?? {})}`;
        if (!want(state) || (re && !re.test(text))) {
          continue;
        }
        total++;
        if (lines.length > 120) {
          continue;
        }
        lines.push(`[${state}] ${r.name} (uid ${r.uid ?? '?'}) folder=${g.file} group=${g.name} health=${r.health}${r.lastError ? ` error="${r.lastError}"` : ''}`);
        if (r.annotations?.summary) {
          lines.push(`   summary: ${String(r.annotations.summary).slice(0, 200)}`);
        }
        lines.push(`   query: ${String(r.query ?? '').slice(0, 300)}`);
        for (const a of (r.alerts ?? []).filter((x: any) => String(x.state).toLowerCase() !== 'normal').slice(0, 8)) {
          lines.push(`   • ${a.state} since ${a.activeAt} value=${a.value} labels=${JSON.stringify(a.labels)}`);
        }
      }
    }
    return total ? clip(`${total} matching rules:\n${lines.join('\n')}`) : 'No matching alert rules.';
  },
};

export const alertHistory: ToolDefinition = {
  schema: {
    name: 'alert_state_history',
    description: 'Get alert state transitions (Normal→Pending→Alerting→Normal) over a time range, optionally for one rule UID. Requires Grafana alert state history to be enabled.',
    input_schema: {
      type: 'object',
      properties: { rule_uid: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  describe: (i) => `Alert history${i.rule_uid ? ` ${i.rule_uid}` : ''}`,
  run: async (input, ctx) => {
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const resp = await ctx.http.get<any>(
      '/api/v1/rules/history',
      { from: Math.floor(range.from / 1000), to: Math.floor(range.to / 1000), ruleUID: input.rule_uid, limit: Math.min(Number(input.limit) || 200, 1000) },
      ctx.signal
    );
    // Response is a data frame: fields time, line (JSON with previous/current state, labels, ruleTitle).
    const fields = resp?.schema?.fields ?? resp?.data?.schema?.fields;
    const values = resp?.data?.values ?? resp?.data?.data?.values;
    if (!fields || !values) {
      return 'No state history returned (state history may be disabled).';
    }
    const ti = fields.findIndex((f: any) => f.name === 'time');
    const li = fields.findIndex((f: any) => f.name === 'line');
    const rows: string[] = [];
    for (let j = 0; j < (values[ti] ?? []).length; j++) {
      const l = values[li][j] ?? {};
      rows.push(`${iso(values[ti][j])} ${l.ruleTitle ?? l.ruleUID ?? ''}: ${l.previous} → ${l.current}${l.values ? ` values=${JSON.stringify(l.values)}` : ''} ${JSON.stringify(l.labels ?? {})}`);
    }
    return rows.length ? clip(rows.join('\n')) : 'No state changes in range.';
  },
};

export const getAnnotations: ToolDefinition = {
  schema: {
    name: 'get_annotations',
    description:
      'List annotations in a time range: deployments, config changes, incidents and alert events that teams mark on dashboards. Essential for correlating a regression with a change. Filter by tags (e.g. deploy) or dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        dashboard_uid: { type: 'string' },
        type: { type: 'string', enum: ['annotation', 'alert'], description: 'annotation = user/API annotations (default), alert = alert events' },
        start: { type: 'string' },
        end: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  describe: (i) => `Annotations${i.tags?.length ? ` #${i.tags.join(',')}` : ''}`,
  run: async (input, ctx) => {
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const params: Record<string, unknown> = {
      from: range.from,
      to: range.to,
      limit: Math.min(Number(input.limit) || 100, 500),
      type: input.type ?? 'annotation',
    };
    if (input.tags?.length) {
      params.tags = input.tags;
      params.matchAny = true;
    }
    if (input.dashboard_uid) {
      params.dashboardUID = input.dashboard_uid;
    }
    const list = await ctx.http.get<any[]>('/api/annotations', params, ctx.signal);
    if (!list?.length) {
      return 'No annotations in range.';
    }
    return clip(
      list
        .sort((a, b) => a.time - b.time)
        .map((a) => `${iso(a.time)}${a.timeEnd && a.timeEnd !== a.time ? `→${iso(a.timeEnd)}` : ''} [${(a.tags ?? []).join(',')}] ${String(a.text ?? '').replace(/<[^>]+>/g, '').slice(0, 300)}${a.dashboardUID ? ` (dash ${a.dashboardUID})` : ''}`)
        .join('\n')
    );
  },
};

export const recordFinding: ToolDefinition = {
  schema: {
    name: 'record_finding',
    description:
      'Record an investigation finding on the live timeline the user sees: a confirmed anomaly, correlation, ruled-out hypothesis, or root-cause candidate. Include the concrete evidence (query + what it showed). Call as you go, not only at the end.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
        evidence: { type: 'string', description: 'Query/tool used and the key numbers or lines it returned' },
      },
      required: ['title', 'detail', 'severity'],
    },
  },
  describe: (i) => `Finding: ${i.title}`,
  run: async (input, ctx) => {
    ctx.recordFinding?.({ title: input.title, detail: input.detail, severity: input.severity ?? 'info', evidence: input.evidence, at: ctx.now() });
    return 'Recorded.';
  },
};

export const grafanaObjectTools = [searchDashboards, getDashboard, runPanelQueries, listAlerts, alertHistory, getAnnotations];
