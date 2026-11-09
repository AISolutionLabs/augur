// Dashboard drafting: the model supplies a compact spec; we produce valid Grafana dashboard JSON,
// lay out the grid, validate datasources and (optionally) dry-run every query against real data.
// Saving is never a tool: only the user's click in the UI saves, and never with overwrite.

import { DataSourceInfo, GrafanaHttp, ToolContext } from './types';
import { dsQuery, errorMessage, LOKI_TYPES, PROM_TYPES, TEMPO_TYPES } from './grafana';
import { framesOf } from './frames';

export type PanelKind = 'timeseries' | 'stat' | 'gauge' | 'bargauge' | 'table' | 'logs' | 'traces' | 'barchart' | 'heatmap' | 'piechart' | 'text';

export interface PanelQuerySpec {
  expr?: string; // PromQL / LogQL
  traceql?: string; // Tempo
  legend?: string;
  instant?: boolean;
}

export interface PanelSpec {
  title: string;
  type: PanelKind;
  datasource_uid?: string; // uid, or ${var} referencing a datasource variable
  queries?: PanelQuerySpec[];
  description?: string;
  unit?: string;
  min?: number;
  max?: number;
  decimals?: number;
  thresholds?: Array<{ value: number | null; color: string }>;
  stack?: boolean;
  width?: number;
  height?: number;
  row?: string;
  content?: string; // markdown for text panels
}

export interface VariableSpec {
  name: string;
  type: 'query' | 'custom' | 'datasource' | 'interval' | 'textbox';
  label?: string;
  datasource_uid?: string;
  query?: string; // label_values(metric, label) / "a,b,c" / "prometheus" for datasource vars
  multi?: boolean;
  include_all?: boolean;
}

export interface DashboardSpec {
  title: string;
  description?: string;
  tags?: string[];
  folder_uid?: string;
  time_from?: string;
  refresh?: string;
  variables?: VariableSpec[];
  panels: PanelSpec[];
  extend_dashboard_uid?: string;
  check_queries?: boolean;
}

export interface QueryCheck {
  panel: string;
  query: string;
  status: 'ok' | 'empty' | 'error' | 'skipped';
  detail?: string;
}

export interface DashboardDraft {
  id: string;
  title: string;
  folderUid?: string;
  json: Record<string, any>;
  outline: string[];
  warnings: string[];
  checks: QueryCheck[];
  basedOn?: string;
  createdAt: number;
}

const DEFAULT_SIZE: Record<PanelKind, [number, number]> = {
  timeseries: [12, 8],
  stat: [6, 4],
  gauge: [6, 6],
  bargauge: [12, 6],
  table: [24, 8],
  logs: [24, 10],
  traces: [24, 8],
  barchart: [12, 8],
  heatmap: [12, 8],
  piechart: [8, 8],
  text: [24, 3],
};

const PANEL_TYPES = Object.keys(DEFAULT_SIZE) as PanelKind[];

function newUid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'cl-';
  for (let i = 0; i < 11; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function isVarRef(s?: string) {
  return !!s && /^\$\{?\w+\}?$/.test(s);
}

function dsRefFor(spec: { datasource_uid?: string }, all: DataSourceInfo[], warnings: string[], where: string) {
  const uid = spec.datasource_uid;
  if (!uid) {
    return undefined;
  }
  if (isVarRef(uid)) {
    return { uid };
  }
  const ds = all.find((d) => d.uid === uid) ?? all.find((d) => d.name === uid);
  if (!ds) {
    warnings.push(`${where}: datasource "${uid}" not found`);
    return { uid };
  }
  return { uid: ds.uid, type: ds.type };
}

export function buildTargets(p: PanelSpec, ds: { uid: string; type?: string } | undefined) {
  const refIds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return (p.queries ?? []).map((q, i) => {
    const base: Record<string, any> = { refId: refIds[i] ?? `Q${i}`, datasource: ds };
    if (p.type === 'traces' || ds?.type === 'tempo' || q.traceql) {
      return { ...base, queryType: 'traceql', query: q.traceql ?? q.expr, limit: 20, tableType: 'traces' };
    }
    if (ds?.type === 'loki') {
      return { ...base, expr: q.expr, queryType: q.instant ? 'instant' : 'range', legendFormat: q.legend, editorMode: 'code' };
    }
    return { ...base, expr: q.expr, legendFormat: q.legend ?? '__auto', range: !q.instant, instant: !!q.instant, editorMode: 'code' };
  });
}

export function buildPanel(p: PanelSpec, id: number, all: DataSourceInfo[], warnings: string[]) {
  const where = `panel "${p.title}"`;
  const type: PanelKind = PANEL_TYPES.includes(p.type) ? p.type : 'timeseries';
  if (type !== p.type) {
    warnings.push(`${where}: unknown type "${p.type}", used timeseries`);
  }
  const ds = type === 'text' ? undefined : dsRefFor(p, all, warnings, where);
  if (type !== 'text' && !ds) {
    warnings.push(`${where}: no datasource_uid`);
  }
  if (type !== 'text' && !(p.queries ?? []).length) {
    warnings.push(`${where}: no queries`);
  }
  const thresholds = {
    mode: 'absolute',
    steps: p.thresholds?.length
      ? p.thresholds.map((t, i) => ({ color: t.color, value: i === 0 ? null : t.value }))
      : [
          { color: 'green', value: null },
          { color: 'red', value: 80 },
        ],
  };
  const defaults: Record<string, any> = { unit: p.unit, min: p.min, max: p.max, decimals: p.decimals, thresholds, color: { mode: 'palette-classic' } };
  const panel: Record<string, any> = {
    id,
    type: type === 'traces' ? 'table' : type,
    title: p.title,
    description: p.description,
    datasource: ds,
    targets: buildTargets(p, ds),
    fieldConfig: { defaults, overrides: [] },
    options: {},
  };
  switch (type) {
    case 'timeseries':
      defaults.custom = { drawStyle: 'line', lineWidth: 1, fillOpacity: 10, showPoints: 'never', spanNulls: false, stacking: { mode: p.stack ? 'normal' : 'none', group: 'A' } };
      panel.options = { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } };
      break;
    case 'stat':
    case 'gauge':
    case 'bargauge':
      defaults.color = { mode: 'thresholds' };
      panel.options = { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'area', textMode: 'auto', orientation: 'auto' };
      break;
    case 'logs':
      delete panel.fieldConfig.defaults.thresholds;
      panel.options = { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, dedupStrategy: 'none', prettifyLogMessage: false };
      break;
    case 'table':
    case 'traces':
      panel.options = { showHeader: true, cellHeight: 'sm' };
      break;
    case 'piechart':
      panel.options = { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, legend: { displayMode: 'table', placement: 'right', values: ['value'] }, pieType: 'donut' };
      break;
    case 'heatmap':
      panel.options = { calculate: false, yAxis: { unit: p.unit } };
      break;
    case 'text':
      panel.options = { mode: 'markdown', content: p.content ?? p.description ?? '' };
      delete panel.targets;
      delete panel.datasource;
      break;
  }
  return panel;
}

export function buildVariable(v: VariableSpec, all: DataSourceInfo[], warnings: string[]) {
  const base: Record<string, any> = { name: v.name, label: v.label ?? v.name, type: v.type, hide: 0, skipUrlSync: false };
  switch (v.type) {
    case 'query': {
      const ds = dsRefFor(v, all, warnings, `variable $${v.name}`);
      if (!v.query) {
        warnings.push(`variable $${v.name}: query is required (e.g. label_values(up, namespace))`);
      }
      return {
        ...base,
        datasource: ds,
        query: v.query ?? '',
        definition: v.query ?? '',
        refresh: 2,
        sort: 1,
        multi: !!v.multi,
        includeAll: !!v.include_all,
        allValue: v.include_all ? '.*' : undefined,
        current: {},
        options: [],
        regex: '',
      };
    }
    case 'custom':
      return { ...base, query: v.query ?? '', multi: !!v.multi, includeAll: !!v.include_all, current: {}, options: [] };
    case 'datasource':
      return { ...base, query: v.query ?? 'prometheus', refresh: 1, regex: '', current: {}, options: [], multi: false, includeAll: false };
    case 'interval':
      return { ...base, query: v.query ?? '1m,5m,10m,30m,1h', auto: false, current: {}, options: [], refresh: 2 };
    case 'textbox':
      return { ...base, query: v.query ?? '', current: { text: v.query ?? '', value: v.query ?? '' }, options: [] };
    default:
      warnings.push(`variable $${(v as any).name}: unknown type`);
      return base;
  }
}

/** Packs panels left-to-right into a 24-column grid, grouped under rows. Returns next free y. */
export function layout(panels: Array<{ spec: PanelSpec; json: Record<string, any> }>, startY: number, nextId: () => number) {
  const out: Array<Record<string, any>> = [];
  const groups = new Map<string, typeof panels>();
  for (const p of panels) {
    const key = p.spec.row ?? '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  let y = startY;
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0));
  for (const key of keys) {
    if (key) {
      out.push({ id: nextId(), type: 'row', title: key, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
      y += 1;
    }
    let x = 0;
    let rowH = 0;
    for (const { spec, json } of groups.get(key)!) {
      const [dw, dh] = DEFAULT_SIZE[(PANEL_TYPES.includes(spec.type) ? spec.type : 'timeseries') as PanelKind];
      const w = Math.min(Math.max(Math.round(spec.width ?? dw), 1), 24);
      const h = Math.min(Math.max(Math.round(spec.height ?? dh), 2), 40);
      if (x + w > 24) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      json.gridPos = { h, w, x, y };
      out.push(json);
      x += w;
      rowH = Math.max(rowH, h);
    }
    y += rowH;
  }
  return { panels: out, y };
}

/** Replace dashboard variables with wildcards so a query can be dry-run. */
export function wildcardVars(expr: string): string {
  return expr
    .replace(/\b(by|without)\s*\(([^)]*)\)/g, (_m, kw: string, inner: string) => `${kw} (${inner.replace(/\$\{?(?!__)\w+(?::\w+)?\}?/g, 'job')})`)
    .replace(/(\w+)\s*=\s*"\$\{?\w+(?::\w+)?\}?"/g, '$1=~".+"')
    .replace(/(\w+)\s*=~\s*"\$\{?\w+(?::\w+)?\}?"/g, '$1=~".+"')
    .replace(/\$\{(?!__)\w+(?::\w+)?\}|\$(?!__)\w+/g, '.+');
}

export async function checkQueries(ctx: ToolContext, specs: PanelSpec[], all: DataSourceInfo[], dsVars: Map<string, string>): Promise<QueryCheck[]> {
  const jobs: Array<() => Promise<QueryCheck>> = [];
  const range = { from: ctx.now() - 3600_000, to: ctx.now() };
  for (const p of specs) {
    for (const q of p.queries ?? []) {
      const text = q.traceql ?? q.expr ?? '';
      let uid = p.datasource_uid ?? '';
      if (isVarRef(uid)) {
        uid = dsVars.get(uid.replace(/[${}]/g, '')) ?? '';
      }
      const ds = all.find((d) => d.uid === uid || d.name === uid);
      if (!ds || !text) {
        jobs.push(async () => ({ panel: p.title, query: text, status: 'skipped', detail: 'no resolvable datasource' }));
        continue;
      }
      const isTempo = TEMPO_TYPES.includes(ds.type);
      if (!PROM_TYPES.includes(ds.type) && !LOKI_TYPES.includes(ds.type) && !isTempo) {
        jobs.push(async () => ({ panel: p.title, query: text, status: 'skipped', detail: `type ${ds.type} not dry-run` }));
        continue;
      }
      jobs.push(async () => {
        try {
          const query = isTempo
            ? { queryType: 'traceql', query: wildcardVars(text), limit: 5, tableType: 'traces' }
            : { expr: wildcardVars(text), queryType: 'range', range: true, maxLines: 5, intervalMs: 60_000, maxDataPoints: 60 };
          const frames = framesOf(await dsQuery(ctx, ds, query, range));
          const n = frames.reduce((acc, f) => acc + ((f.data?.values?.[0] as unknown[] | undefined)?.length ?? 0), 0);
          return { panel: p.title, query: text, status: n > 0 ? 'ok' : 'empty', detail: n > 0 ? `${frames.length} frame(s)` : 'no data in last 1h' };
        } catch (e) {
          return { panel: p.title, query: text, status: 'error', detail: errorMessage(e).slice(0, 300) };
        }
      });
    }
  }
  const results: QueryCheck[] = [];
  const limited = jobs.slice(0, 40);
  for (let i = 0; i < limited.length; i += 4) {
    if (ctx.signal.aborted) {
      break;
    }
    results.push(...(await Promise.all(limited.slice(i, i + 4).map((j) => j()))));
  }
  if (jobs.length > limited.length) {
    results.push({ panel: '…', query: '', status: 'skipped', detail: `${jobs.length - limited.length} more queries not checked` });
  }
  return results;
}

export async function buildDashboardDraft(spec: DashboardSpec, ctx: ToolContext): Promise<DashboardDraft> {
  if (!spec?.title) {
    throw new Error('title is required');
  }
  if (!Array.isArray(spec.panels) || !spec.panels.length) {
    throw new Error('panels must be a non-empty array');
  }
  if (spec.panels.length > 60) {
    throw new Error('too many panels (max 60); split into multiple dashboards');
  }
  const all = ctx.listDataSources();
  const warnings: string[] = [];

  let base: Record<string, any> | undefined;
  if (spec.extend_dashboard_uid) {
    const resp = await ctx.http.get<{ dashboard: Record<string, any> }>(`/api/dashboards/uid/${encodeURIComponent(spec.extend_dashboard_uid)}`, undefined, ctx.signal);
    base = resp.dashboard;
  }

  let maxId = 0;
  let startY = 0;
  if (base) {
    const walk = (ps: any[] = []) =>
      ps.forEach((p) => {
        maxId = Math.max(maxId, Number(p.id) || 0);
        startY = Math.max(startY, (p.gridPos?.y ?? 0) + (p.gridPos?.h ?? 0));
        walk(p.panels);
      });
    walk(base.panels);
  }
  const nextId = () => ++maxId;

  const built = spec.panels.map((p) => ({ spec: p, json: buildPanel(p, nextId(), all, warnings) }));
  const titles = new Set<string>();
  spec.panels.forEach((p) => {
    if (titles.has(p.title)) {
      warnings.push(`duplicate panel title "${p.title}"`);
    }
    titles.add(p.title);
  });
  const { panels } = layout(built, startY, nextId);

  const variables = (spec.variables ?? []).map((v) => buildVariable(v, all, warnings));
  const varNames = new Set(variables.map((v) => v.name));
  const referenced = JSON.stringify(spec.panels).match(/\$\{?(\w+)/g) ?? [];
  for (const r of referenced) {
    const name = r.replace(/[${]/g, '');
    if (!name.startsWith('__') && !varNames.has(name) && !(base?.templating?.list ?? []).some((v: any) => v.name === name)) {
      warnings.push(`query references $${name} but no such variable is defined`);
    }
  }

  const json: Record<string, any> = base
    ? {
        ...base,
        id: null,
        uid: newUid(),
        version: 0,
        title: spec.title,
        description: spec.description ?? base.description,
        tags: [...new Set([...(base.tags ?? []), ...(spec.tags ?? []), 'claude'])],
        panels: [...(base.panels ?? []), ...panels],
        templating: { list: [...(base.templating?.list ?? []), ...variables.filter((v) => !(base!.templating?.list ?? []).some((b: any) => b.name === v.name))] },
      }
    : {
        id: null,
        uid: newUid(),
        title: spec.title,
        description: spec.description,
        tags: [...new Set([...(spec.tags ?? []), 'claude'])],
        timezone: 'browser',
        editable: true,
        graphTooltip: 1,
        schemaVersion: 39,
        version: 0,
        time: { from: spec.time_from ?? 'now-6h', to: 'now' },
        refresh: spec.refresh ?? '',
        templating: { list: variables },
        annotations: {
          list: [
            {
              builtIn: 1,
              datasource: { type: 'grafana', uid: '-- Grafana --' },
              enable: true,
              hide: true,
              iconColor: 'rgba(0, 211, 255, 1)',
              name: 'Annotations & Alerts',
              type: 'dashboard',
            },
          ],
        },
        panels,
      };

  const dsVars = new Map<string, string>();
  for (const v of spec.variables ?? []) {
    if (v.type === 'datasource') {
      const first = all.find((d) => d.type === (v.query ?? 'prometheus'));
      if (first) {
        dsVars.set(v.name, first.uid);
      }
    }
  }
  const checks = spec.check_queries === false ? [] : await checkQueries(ctx, spec.panels, all, dsVars);

  const outline = panels.map((p) =>
    p.type === 'row'
      ? `▸ ${p.title}`
      : `  ${p.title} — ${p.type} (${p.gridPos.w}×${p.gridPos.h})${(p.targets ?? []).length ? `: ${(p.targets ?? []).map((t: any) => t.expr ?? t.query).join(' ; ').slice(0, 160)}` : ''}`
  );
  return {
    id: json.uid,
    title: spec.title,
    folderUid: spec.folder_uid,
    json,
    outline,
    warnings,
    checks,
    basedOn: spec.extend_dashboard_uid,
    createdAt: ctx.now(),
  };
}

export async function saveDashboard(http: GrafanaHttp, draft: DashboardDraft, folderUid?: string) {
  return http.post<{ uid: string; url: string; status: string; version: number }>('/api/dashboards/db', {
    dashboard: draft.json,
    folderUid: folderUid ?? draft.folderUid ?? '',
    overwrite: false,
    message: 'Created with Claude',
  });
}
