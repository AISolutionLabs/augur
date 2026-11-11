// Dashboard drafting: the model supplies a compact spec; we produce valid Grafana dashboard JSON,
// lay out the grid, validate datasources and (optionally) dry-run every query against real data.
// Saving is never a tool: only the user's click in the UI saves, and never with overwrite.

import { DataSourceInfo, GrafanaHttp, ToolContext } from './types';
import { dsQuery, errorMessage, LOKI_TYPES, PROM_TYPES, TEMPO_TYPES } from './grafana';
import { framesOf } from './frames';

export type PanelKind =
  | 'timeseries'
  | 'stat'
  | 'gauge'
  | 'bargauge'
  | 'table'
  | 'logs'
  | 'traces'
  | 'barchart'
  | 'heatmap'
  | 'piechart'
  | 'text'
  | 'state-timeline'
  | 'status-history'
  | 'histogram'
  | 'flamegraph';

export interface PanelQuerySpec {
  expr?: string; // PromQL / LogQL
  traceql?: string; // Tempo
  legend?: string;
  instant?: boolean;
  /** Pyroscope: profile type, e.g. process_cpu:cpu:nanoseconds:cpu:nanoseconds */
  profile_type?: string;
  /** Pyroscope: label selector, e.g. {service_name="checkout"} */
  label_selector?: string;
  /** Hide this query's series (e.g. helper queries used by transformations). */
  hide?: boolean;
}

/** Per-series styling: match series/fields by name or regex. */
export interface OverrideSpec {
  match: string;
  /** Treat match as a regular expression (default: exact field/series name). */
  regex?: boolean;
  unit?: string;
  color?: string;
  axis?: 'left' | 'right' | 'hidden';
  draw_style?: 'line' | 'bars' | 'points';
  fill_opacity?: number;
  dashed?: boolean;
  stack?: boolean;
  hide?: boolean;
  display_name?: string;
}

export interface MappingSpec {
  /** Exact value to map (e.g. "1", "true"). */
  value?: string;
  /** Or a numeric range. */
  from?: number;
  to?: number;
  text: string;
  color?: string;
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
  /** Legend: list (default), table (with calcs) or hidden; bottom (default) or right. */
  legend?: { mode?: 'list' | 'table' | 'hidden'; placement?: 'bottom' | 'right'; calcs?: string[] };
  /** Fixed colour (name or hex), 'thresholds', or a scheme such as 'continuous-GrYlRd'. */
  color?: string;
  /** Draw thresholds on time series: line, area or off (default off). */
  threshold_style?: 'line' | 'area' | 'off';
  draw_style?: 'line' | 'bars' | 'points';
  fill_opacity?: number;
  line_width?: number;
  gradient?: 'none' | 'opacity' | 'hue' | 'scheme';
  axis_label?: string;
  log_scale?: boolean;
  /** Stat/gauge/bargauge/piechart reduction: lastNotNull (default), mean, max, min, sum, last, count. */
  reduce?: string;
  /** Stat: sparkline (default true) and colour mode. */
  sparkline?: boolean;
  color_mode?: 'value' | 'background' | 'none';
  overrides?: OverrideSpec[];
  mappings?: MappingSpec[];
  /** Panel links shown in the panel header, and a data link on every value. */
  links?: Array<{ title: string; url: string }>;
  data_link?: { title: string; url: string };
  /** Repeat the panel for each value of this variable. */
  repeat?: string;
  repeat_direction?: 'h' | 'v';
  /** Grafana transformations, passed through as-is (advanced). */
  transformations?: Array<Record<string, unknown>>;
  /** Minimum query interval (e.g. 1m) and max data points. */
  interval?: string;
  max_data_points?: number;
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

/** Query annotation: events from a Loki or Prometheus query drawn as markers on every time series panel. */
export interface AnnotationSpec {
  name: string;
  datasource_uid: string;
  expr: string;
  /** Loki: label or extracted field names whose values become annotation tags, comma separated. */
  tag_keys?: string;
  /** Marker title / text, e.g. "Deploy {{service}}" and "{{version}}" (labels or extracted fields). */
  title_format?: string;
  text_format?: string;
  color?: string;
  enabled?: boolean;
}

export interface DashboardSpec {
  title: string;
  description?: string;
  tags?: string[];
  folder_uid?: string;
  time_from?: string;
  refresh?: string;
  variables?: VariableSpec[];
  annotations?: AnnotationSpec[];
  panels: PanelSpec[];
  extend_dashboard_uid?: string;
  check_queries?: boolean;
  /** Section (row) names that start collapsed. */
  collapsed_rows?: string[];
}

export interface QueryCheck {
  panel: string;
  query: string;
  status: 'ok' | 'empty' | 'error' | 'skipped';
  detail?: string;
  /** Number of series/frames the query returned in the dry run. */
  series?: number;
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
  /** The spec this draft was built from (after automatic fixes), for incremental revisions. */
  spec?: DashboardSpec;
  /** Automatic fixes applied (rate windows, inferred units…). */
  fixes?: string[];
  /** Revision number within the conversation (1 = first draft). */
  revision?: number;
  /** Id of the first draft this one revises; drafts with the same lineage are versions of one dashboard. */
  lineage?: string;
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
  'state-timeline': [24, 6],
  'status-history': [24, 6],
  histogram: [12, 8],
  flamegraph: [24, 12],
};

/** Grafana dashboard JSON schema version the builder emits (Grafana 12+). */
export const SCHEMA_VERSION = 41;

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
    const base: Record<string, any> = { refId: refIds[i] ?? `Q${i}`, datasource: ds, ...(q.hide ? { hide: true } : {}) };
    if (p.type === 'flamegraph' || ds?.type === 'grafana-pyroscope-datasource' || q.profile_type) {
      return { ...base, queryType: 'profile', profileTypeId: q.profile_type ?? 'process_cpu:cpu:nanoseconds:cpu:nanoseconds', labelSelector: q.label_selector ?? q.expr ?? '{}', groupBy: [] };
    }
    if (p.type === 'traces' || ds?.type === 'tempo' || q.traceql) {
      return { ...base, queryType: 'traceql', query: q.traceql ?? q.expr, limit: 20, tableType: 'traces' };
    }
    if (ds?.type === 'loki') {
      return { ...base, expr: q.expr, queryType: q.instant ? 'instant' : 'range', legendFormat: q.legend, editorMode: 'code' };
    }
    if (p.type === 'heatmap' && /_bucket\b/.test(q.expr ?? '')) {
      return { ...base, expr: q.expr, legendFormat: '{{le}}', format: 'heatmap', range: true, instant: false, editorMode: 'code' };
    }
    return { ...base, expr: q.expr, legendFormat: q.legend ?? '__auto', range: !q.instant, instant: !!q.instant, editorMode: 'code' };
  });
}

const NAMED_COLORS = /^(#[0-9a-f]{3,8}|(semi-)?(dark-|light-|super-light-)?(green|red|blue|yellow|orange|purple|text|transparent)|rgba?\(.+\))$/i;

function colorConfig(color: string | undefined, fallback: Record<string, unknown>) {
  if (!color) {
    return fallback;
  }
  if (color === 'thresholds') {
    return { mode: 'thresholds' };
  }
  if (color === 'palette' || color === 'palette-classic') {
    return { mode: 'palette-classic' };
  }
  if (/^(continuous|shades)-/.test(color) || color === 'palette-classic-by-name') {
    return { mode: color };
  }
  if (NAMED_COLORS.test(color)) {
    return { mode: 'fixed', fixedColor: color };
  }
  return fallback;
}

function buildOverrides(list: OverrideSpec[] = []) {
  return list
    .filter((o) => o?.match)
    .map((o) => {
      const properties: Array<{ id: string; value: unknown }> = [];
      const custom = (id: string, value: unknown) => properties.push({ id: `custom.${id}`, value });
      if (o.display_name) {
        properties.push({ id: 'displayName', value: o.display_name });
      }
      if (o.unit) {
        properties.push({ id: 'unit', value: o.unit });
      }
      if (o.color) {
        properties.push({ id: 'color', value: colorConfig(o.color, { mode: 'fixed', fixedColor: o.color }) });
      }
      if (o.axis) {
        custom('axisPlacement', o.axis);
      }
      if (o.draw_style) {
        custom('drawStyle', o.draw_style);
      }
      if (o.fill_opacity !== undefined) {
        custom('fillOpacity', o.fill_opacity);
      }
      if (o.dashed) {
        custom('lineStyle', { fill: 'dash', dash: [10, 10] });
      }
      if (o.stack !== undefined) {
        custom('stacking', { mode: o.stack ? 'normal' : 'none', group: 'A' });
      }
      if (o.hide) {
        custom('hideFrom', { legend: true, tooltip: true, viz: true });
      }
      return { matcher: o.regex ? { id: 'byRegexp', options: o.match } : { id: 'byName', options: o.match }, properties };
    })
    .filter((o) => o.properties.length);
}

function buildMappings(list: MappingSpec[] = []) {
  const valueMap: Record<string, { text: string; color?: string; index: number }> = {};
  const out: Array<Record<string, unknown>> = [];
  list.forEach((m, index) => {
    if (m.value !== undefined) {
      valueMap[String(m.value)] = { text: m.text, color: m.color, index };
    } else if (m.from !== undefined || m.to !== undefined) {
      out.push({ type: 'range', options: { from: m.from ?? null, to: m.to ?? null, result: { text: m.text, color: m.color, index } } });
    }
  });
  if (Object.keys(valueMap).length) {
    out.unshift({ type: 'value', options: valueMap });
  }
  return out;
}

export function buildPanel(p: PanelSpec, id: number, all: DataSourceInfo[], warnings: string[], installed?: Set<string>) {
  const where = `panel "${p.title}"`;
  let type: PanelKind = PANEL_TYPES.includes(p.type) ? p.type : 'timeseries';
  if (type !== p.type) {
    warnings.push(`${where}: unknown type "${p.type}", used timeseries`);
  }
  const vizType = type === 'traces' ? 'table' : type;
  if (installed && installed.size && !installed.has(vizType)) {
    warnings.push(`${where}: panel type "${vizType}" is not installed in this Grafana, used timeseries`);
    type = 'timeseries';
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
  const defaults: Record<string, any> = {
    unit: p.unit,
    min: p.min,
    max: p.max,
    decimals: p.decimals,
    thresholds,
    color: colorConfig(p.color, { mode: 'palette-classic' }),
    mappings: buildMappings(p.mappings),
  };
  if (p.data_link?.url) {
    defaults.links = [{ title: p.data_link.title, url: p.data_link.url }];
  }
  const legend = {
    showLegend: p.legend?.mode !== 'hidden',
    displayMode: p.legend?.mode === 'table' ? 'table' : 'list',
    placement: p.legend?.placement ?? 'bottom',
    calcs: p.legend?.calcs ?? (p.legend?.mode === 'table' ? ['mean', 'max', 'lastNotNull'] : []),
  };
  const reduceOptions = { calcs: [p.reduce ?? 'lastNotNull'], fields: '', values: false };
  const panel: Record<string, any> = {
    id,
    type: type === 'traces' ? 'table' : type,
    title: p.title,
    description: p.description,
    datasource: ds,
    targets: buildTargets({ ...p, type }, ds),
    fieldConfig: { defaults, overrides: buildOverrides(p.overrides) },
    options: {},
  };
  if (p.links?.length) {
    panel.links = p.links.filter((l) => l?.url).map((l) => ({ title: l.title, url: l.url }));
  }
  if (p.repeat) {
    panel.repeat = p.repeat.replace(/^\$/, '');
    panel.repeatDirection = p.repeat_direction ?? 'h';
    panel.maxPerRow = 4;
  }
  if (p.transformations?.length) {
    panel.transformations = p.transformations;
  }
  if (p.interval) {
    panel.interval = p.interval;
  }
  if (p.max_data_points) {
    panel.maxDataPoints = p.max_data_points;
  }
  const axis = { axisLabel: p.axis_label ?? '', axisPlacement: 'auto', scaleDistribution: p.log_scale ? { type: 'log', log: 2 } : { type: 'linear' } };
  switch (type) {
    case 'timeseries':
    case 'barchart':
    case 'histogram':
      defaults.custom = {
        ...axis,
        drawStyle: p.draw_style ?? 'line',
        lineWidth: p.line_width ?? (p.draw_style === 'bars' ? 0 : 1),
        fillOpacity: p.fill_opacity ?? (p.stack ? 60 : p.draw_style === 'bars' ? 80 : 12),
        gradientMode: p.gradient ?? 'opacity',
        showPoints: 'never',
        pointSize: 4,
        lineInterpolation: 'smooth',
        spanNulls: false,
        barAlignment: 0,
        stacking: { mode: p.stack ? 'normal' : 'none', group: 'A' },
        thresholdsStyle: { mode: p.threshold_style === 'line' ? 'line' : p.threshold_style === 'area' ? 'area' : 'off' },
      };
      if (type === 'timeseries') {
        panel.options = { legend, tooltip: { mode: 'multi', sort: 'desc' } };
      } else if (type === 'barchart') {
        panel.options = { legend, tooltip: { mode: 'multi', sort: 'desc' }, orientation: 'auto', xTickLabelRotation: 0, showValue: 'auto', stacking: p.stack ? 'normal' : 'none' };
      } else {
        panel.options = { legend, tooltip: { mode: 'single' }, bucketCount: 30 };
      }
      break;
    case 'stat':
      defaults.color = colorConfig(p.color, { mode: 'thresholds' });
      panel.options = {
        reduceOptions,
        colorMode: p.color_mode ?? 'value',
        graphMode: p.sparkline === false ? 'none' : 'area',
        textMode: 'auto',
        justifyMode: 'auto',
        orientation: 'auto',
        wideLayout: true,
        showPercentChange: false,
      };
      break;
    case 'gauge':
      defaults.color = colorConfig(p.color, { mode: 'thresholds' });
      panel.options = { reduceOptions, showThresholdLabels: false, showThresholdMarkers: true, orientation: 'auto' };
      break;
    case 'bargauge':
      defaults.color = colorConfig(p.color, { mode: 'thresholds' });
      panel.options = { reduceOptions, displayMode: 'gradient', orientation: 'horizontal', valueMode: 'color', namePlacement: 'auto', showUnfilled: true, sizing: 'auto', minVizHeight: 16, maxVizHeight: 300 };
      break;
    case 'state-timeline':
    case 'status-history':
      defaults.color = colorConfig(p.color, { mode: 'thresholds' });
      defaults.custom = { lineWidth: 0, fillOpacity: 80 };
      panel.options = { legend, tooltip: { mode: 'single' }, showValue: 'auto', rowHeight: 0.9, ...(type === 'state-timeline' ? { mergeValues: true, alignValue: 'left' } : {}) };
      break;
    case 'logs':
      delete panel.fieldConfig.defaults.thresholds;
      panel.options = { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true, enableInfiniteScrolling: true, dedupStrategy: 'none', prettifyLogMessage: false, showCommonLabels: false };
      break;
    case 'table':
    case 'traces':
      defaults.custom = { align: 'auto', cellOptions: { type: 'auto' }, filterable: true };
      panel.options = { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], countRows: false } };
      break;
    case 'piechart':
      panel.options = { reduceOptions, legend: { displayMode: 'table', placement: 'right', values: ['value', 'percent'], showLegend: true }, pieType: 'donut', tooltip: { mode: 'single' }, displayLabels: [] };
      break;
    case 'heatmap':
      panel.options = {
        calculate: false,
        yAxis: { unit: p.unit, axisPlacement: 'left' },
        color: { mode: 'scheme', scheme: 'Oranges', steps: 64, exponent: 0.5, fill: 'dark-orange', reverse: false },
        cellGap: 1,
        tooltip: { mode: 'single', yHistogram: true },
        legend: { show: true },
        rowsFrame: { layout: 'auto' },
      };
      break;
    case 'flamegraph':
      delete panel.fieldConfig.defaults.thresholds;
      panel.options = {};
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

const BUILT_IN_ANNOTATION = {
  builtIn: 1,
  datasource: { type: 'grafana', uid: '-- Grafana --' },
  enable: true,
  hide: true,
  iconColor: 'rgba(0, 211, 255, 1)',
  name: 'Annotations & Alerts',
  type: 'dashboard',
};

export function buildAnnotation(a: AnnotationSpec, all: DataSourceInfo[], warnings: string[]) {
  const where = `annotation "${a.name}"`;
  if (!a.expr) {
    warnings.push(`${where}: expr is required`);
  }
  const ds = dsRefFor(a, all, warnings, where);
  if (ds?.type && ds.type !== 'loki' && ds.type !== 'prometheus') {
    warnings.push(`${where}: only Loki and Prometheus query annotations are supported (got ${ds.type})`);
  }
  const json: Record<string, any> = {
    name: a.name,
    datasource: ds,
    enable: a.enabled !== false,
    hide: false,
    iconColor: a.color ?? 'rgba(255, 152, 48, 1)',
    // Grafana reads the query from target (current) or the top-level fields (older versions).
    expr: a.expr,
    target: { refId: 'Anno', expr: a.expr },
    titleFormat: a.title_format ?? '',
    textFormat: a.text_format ?? '',
    tagKeys: a.tag_keys ?? '',
  };
  if (ds?.type === 'loki') {
    json.instant = false;
  } else {
    json.step = '60s';
    json.useValueForTime = false;
  }
  return json;
}

/** Packs panels left-to-right into a 24-column grid, grouped under rows. Returns next free y. */
const SMALL: PanelKind[] = ['stat', 'gauge'];

/**
 * Lays panels out on Grafana's 24-column grid: sections (rows) in order of first appearance, runs of
 * stats spread across the width, rows filled edge to edge, and equal heights within a row. Panels
 * with an explicit width or height keep it.
 */
export function layout(panels: Array<{ spec: PanelSpec; json: Record<string, any> }>, startY: number, nextId: () => number, collapsed: string[] = []) {
  const out: Array<Record<string, any>> = [];
  const groups = new Map<string, typeof panels>();
  for (const p of panels) {
    const key = p.spec.row ?? '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0));
  let y = startY;
  for (const key of keys) {
    const items = groups.get(key)!;
    const kind = (sp: PanelSpec) => (PANEL_TYPES.includes(sp.type) ? sp.type : 'timeseries') as PanelKind;
    // Default widths: a run of stats shares the row.
    const widths = items.map(({ spec }) => spec.width);
    for (let i = 0; i < items.length; ) {
      if (!SMALL.includes(kind(items[i].spec)) || items[i].spec.width) {
        i++;
        continue;
      }
      let j = i;
      while (j < items.length && SMALL.includes(kind(items[j].spec)) && !items[j].spec.width) {
        j++;
      }
      const n = j - i;
      const per = Math.max(3, Math.min(8, Math.floor(24 / Math.min(n, 8))));
      for (let k = i; k < j; k++) {
        widths[k] = per;
      }
      i = j;
    }
    // Pack into visual rows.
    const rows: Array<Array<{ json: Record<string, any>; w: number; h: number; fixedW: boolean; fixedH: boolean }>> = [];
    let cur: (typeof rows)[number] = [];
    let used = 0;
    items.forEach(({ spec, json }, idx) => {
      const [dw, dh] = DEFAULT_SIZE[kind(spec)];
      const w = Math.min(Math.max(Math.round(widths[idx] ?? dw), 1), 24);
      const h = Math.min(Math.max(Math.round(spec.height ?? dh), 2), 40);
      if (used + w > 24 && cur.length) {
        rows.push(cur);
        cur = [];
        used = 0;
      }
      cur.push({ json, w, h, fixedW: !!spec.width, fixedH: !!spec.height });
      used += w;
    });
    if (cur.length) {
      rows.push(cur);
    }
    const isCollapsed = !!key && collapsed.includes(key);
    const rowJson = key ? { id: nextId(), type: 'row', title: key, collapsed: isCollapsed, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] as Array<Record<string, any>> } : undefined;
    if (rowJson) {
      out.push(rowJson);
      y += 1;
    }
    let py = y;
    for (const r of rows) {
      // Fill the row: stretch flexible panels proportionally to use all 24 columns.
      const total = r.reduce((a, c) => a + c.w, 0);
      const flex = r.filter((c) => !c.fixedW);
      if (total < 24 && flex.length) {
        let spare = 24 - total;
        const flexTotal = flex.reduce((a, c) => a + c.w, 0);
        flex.forEach((c, i) => {
          const add = i === flex.length - 1 ? spare : Math.floor(((24 - total) * c.w) / flexTotal);
          c.w += add;
          spare -= add;
        });
      }
      const rowH = Math.max(...r.map((c) => c.h));
      let x = 0;
      for (const c of r) {
        const h = c.fixedH ? c.h : rowH;
        c.json.gridPos = { h, w: c.w, x, y: py };
        x += c.w;
        if (isCollapsed) {
          rowJson!.panels.push(c.json);
        } else {
          out.push(c.json);
        }
      }
      py += rowH;
    }
    // A collapsed row takes one grid row; its panels live inside it.
    y = isCollapsed ? y : py;
  }
  return { panels: out, y };
}

// ---- query lint -------------------------------------------------------------------------

const RATE_FNS = /\b(rate|irate|increase|delta|idelta|deriv|resets|changes|predict_linear)\s*\(/;
const COUNTER = /\b([a-zA-Z_:][\w:]*_(total|count|sum|bucket))\b/g;

/** Infers a Grafana unit from a PromQL expression's metric names, when the model gave none. */
export function inferUnit(expr: string): string | undefined {
  const e = expr.toLowerCase();
  const rated = RATE_FNS.test(e);
  if ((/\*\s*100\b/.test(e) || /\b100\s*\*/.test(e)) && e.includes('/')) {
    return 'percent';
  }
  if (e.includes('/') && /(error|fail|5xx|5\.\.|status=~"5|code=~"5)/.test(e) && !/histogram_quantile/.test(e)) {
    return 'percentunit';
  }
  if (/_seconds(_bucket|_sum|_count|_total)?\b/.test(e) && (/histogram_quantile/.test(e) || /_sum\b[^/]*\/[^/]*_count\b/.test(e) || !rated)) {
    return 's';
  }
  if (/_seconds_total\b/.test(e) && rated) {
    return 'percentunit'; // e.g. CPU seconds per second
  }
  if (/_bytes(_total)?\b/.test(e)) {
    return rated ? 'Bps' : 'bytes';
  }
  if (/_ratio\b/.test(e)) {
    return 'percentunit';
  }
  if (/_percent(age)?\b/.test(e)) {
    return 'percent';
  }
  if (/_celsius\b/.test(e)) {
    return 'celsius';
  }
  if (rated && /_total\b/.test(e)) {
    return /(request|http|grpc|rpc|call)/.test(e) ? 'reqps' : 'ops';
  }
  return undefined;
}

/**
 * Checks PromQL panels for common mistakes and fixes the safe ones: short fixed rate windows become
 * $__rate_interval, missing units are inferred from metric names, histogram buckets in heatmaps use
 * the heatmap format. Returns the fixed panel plus notes and warnings for the model.
 */
export function lintPanel(p: PanelSpec, dsType: string | undefined): { panel: PanelSpec; fixes: string[]; warnings: string[] } {
  const fixes: string[] = [];
  const warnings: string[] = [];
  const where = `panel "${p.title}"`;
  const isProm = dsType ? PROM_TYPES.includes(dsType) : (p.queries ?? []).some((q) => q.expr && !q.expr.trim().startsWith('{'));
  const isLoki = dsType ? LOKI_TYPES.includes(dsType) : false;
  const queries = (p.queries ?? []).map((q) => ({ ...q }));
  if (isProm && !isLoki) {
    for (const q of queries) {
      if (!q.expr) {
        continue;
      }
      const before = q.expr;
      q.expr = q.expr.replace(/\b(rate|increase)\s*\(([^()]*?)\[(1m|2m|3m|4m|5m|30s|1m30s)\]\s*\)/g, (_m, fn: string, inner: string) => `${fn}(${inner}[$__rate_interval])`);
      if (q.expr !== before) {
        fixes.push(`${where}: rate window → $__rate_interval`);
      }
      const counters = [...q.expr.matchAll(COUNTER)].map((m) => m[1]);
      if (counters.length && !RATE_FNS.test(q.expr) && !/histogram_quantile/.test(q.expr)) {
        warnings.push(`${where}: ${counters[0]} is a counter; wrap it in rate()/increase() (raw counters only go up)`);
      }
      if (/_bucket\b/.test(q.expr) && !/histogram_quantile/.test(q.expr) && p.type !== 'heatmap') {
        warnings.push(`${where}: ${q.expr.match(/\w+_bucket/)?.[0]} needs histogram_quantile(0.95, sum by (le) (rate(...[$__rate_interval]))) or a heatmap panel`);
      }
      if (/histogram_quantile/.test(q.expr) && !/\ble\b/.test(q.expr.replace(/histogram_quantile\s*\(/, ''))) {
        warnings.push(`${where}: histogram_quantile needs "le" in the aggregation, e.g. sum by (le, service) (rate(..._bucket[$__rate_interval]))`);
      }
    }
    if (!p.unit && !['text', 'logs', 'traces', 'table', 'state-timeline', 'status-history'].includes(p.type)) {
      const unit = queries.map((q) => (q.expr ? inferUnit(q.expr) : undefined)).find(Boolean);
      if (unit) {
        fixes.push(`${where}: unit ${unit} inferred from the metric name`);
        return finish({ ...p, queries, unit });
      }
    }
  }
  if (isLoki) {
    const metric = (q: PanelQuerySpec) => /\b(count_over_time|rate|bytes_over_time|bytes_rate|sum_over_time|avg_over_time|quantile_over_time|absent_over_time)\s*\(/.test(q.expr ?? '');
    if (p.type === 'logs' && queries.some(metric)) {
      warnings.push(`${where}: logs panels need a log query (no count_over_time/rate); use a time series panel for metric queries`);
    }
    if (['timeseries', 'stat', 'barchart', 'bargauge', 'piechart'].includes(p.type) && queries.some((q) => q.expr && !metric(q))) {
      warnings.push(`${where}: a ${p.type} panel needs a LogQL metric query, e.g. sum by (level) (count_over_time({...}[$__auto]))`);
    }
  }
  return finish({ ...p, queries });

  function finish(panel: PanelSpec) {
    return { panel, fixes, warnings };
  }
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
          return { panel: p.title, query: text, status: n > 0 ? 'ok' : 'empty', detail: n > 0 ? `${frames.length} series` : 'no data in last 1h', series: frames.length };
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

  // Datasource type per panel (variables resolve to the type of their datasource variable).
  const dsVarTypes = new Map((spec.variables ?? []).filter((v) => v.type === 'datasource').map((v) => [v.name, v.query ?? 'prometheus']));
  const dsTypeOf = (uid?: string) => {
    if (!uid) {
      return undefined;
    }
    if (isVarRef(uid)) {
      return dsVarTypes.get(uid.replace(/[${}]/g, ''));
    }
    return (all.find((d) => d.uid === uid) ?? all.find((d) => d.name === uid))?.type;
  };
  const fixes: string[] = [];
  const linted = spec.panels.map((p) => {
    const r = lintPanel(p, dsTypeOf(p.datasource_uid));
    fixes.push(...r.fixes);
    warnings.push(...r.warnings);
    return r.panel;
  });
  const built = linted.map((p) => ({ spec: p, json: buildPanel(p, nextId(), all, warnings, ctx.panelTypes) }));
  const titles = new Set<string>();
  spec.panels.forEach((p) => {
    if (titles.has(p.title)) {
      warnings.push(`duplicate panel title "${p.title}"`);
    }
    titles.add(p.title);
  });
  const { panels } = layout(built, startY, nextId, spec.collapsed_rows);

  const variables = (spec.variables ?? []).map((v) => buildVariable(v, all, warnings));
  const annotations = (spec.annotations ?? []).map((a) => buildAnnotation(a, all, warnings));
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
        annotations: { list: [...(base.annotations?.list ?? [BUILT_IN_ANNOTATION]), ...annotations] },
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
        schemaVersion: SCHEMA_VERSION,
        version: 0,
        time: { from: spec.time_from ?? 'now-6h', to: 'now' },
        refresh: spec.refresh ?? '',
        templating: { list: variables },
        annotations: { list: [BUILT_IN_ANNOTATION, ...annotations] },
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
  const checks = spec.check_queries === false ? [] : await checkQueries(ctx, linted, all, dsVars);
  for (const c of checks) {
    if ((c.series ?? 0) > 30) {
      warnings.push(`panel "${c.panel}": ${c.series} series is hard to read; aggregate (sum by a label), use topk(10, …), or a table`);
    }
  }

  const flat = panels.flatMap((p) => (p.type === 'row' ? [p, ...(p.panels ?? [])] : [p]));
  const outline = flat.map((p) =>
    p.type === 'row'
      ? `▸ ${p.title}${p.collapsed ? ' (collapsed)' : ''}`
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
    spec: { ...spec, panels: linted },
    fixes,
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
