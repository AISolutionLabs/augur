import { ToolDefinition } from '../types';
import { AnnotationSpec, buildDashboardDraft, DashboardDraft, DashboardSpec, PanelSpec, VariableSpec } from '../dashboard';

export const listFolders: ToolDefinition = {
  schema: {
    name: 'list_folders',
    description: 'List dashboard folders (uid and title) so a new dashboard can be placed in the right folder.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  describe: () => 'List folders',
  run: async (input, ctx) => {
    const hits = await ctx.http.get<Array<{ uid: string; title: string; folderTitle?: string }>>(
      '/api/search',
      { type: 'dash-folder', query: input.query ?? '', limit: 200 },
      ctx.signal
    );
    return hits?.length ? hits.map((h) => `${h.uid} | ${h.folderTitle ? h.folderTitle + ' / ' : ''}${h.title}`).join('\n') : 'No folders (dashboards go to General).';
  },
};

export const annotationSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    datasource_uid: { type: 'string', description: 'Loki or Prometheus datasource' },
    expr: { type: 'string', description: 'LogQL (each line becomes an event, e.g. {app="x"} |= "deployed" | json) or PromQL (non-zero samples become events, e.g. changes(kube_deployment_status_observed_generation[2m]) > 0)' },
    tag_keys: { type: 'string', description: 'Loki: comma-separated labels/fields to use as tags, e.g. service,version' },
    title_format: { type: 'string', description: 'e.g. Deploy {{service}}' },
    text_format: { type: 'string', description: 'e.g. {{version}} {{message}}' },
    color: { type: 'string' },
    enabled: { type: 'boolean' },
  },
  required: ['name', 'datasource_uid', 'expr'],
};

const panelSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    type: {
      type: 'string',
      enum: ['timeseries', 'stat', 'gauge', 'bargauge', 'table', 'logs', 'traces', 'barchart', 'heatmap', 'piechart', 'text', 'state-timeline', 'status-history', 'histogram', 'flamegraph'],
      description: 'Only types installed in this Grafana (see the installed panel types).',
    },
    datasource_uid: { type: 'string', description: 'Datasource UID, or ${var} for a datasource variable' },
    queries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: 'PromQL or LogQL. Use $__rate_interval in rate()/increase() and dashboard variables like $namespace.' },
          traceql: { type: 'string', description: 'TraceQL for Tempo panels' },
          legend: { type: 'string', description: 'Legend format, e.g. {{pod}}' },
          instant: { type: 'boolean' },
          profile_type: { type: 'string', description: 'Pyroscope (flamegraph panels): profile type, e.g. process_cpu:cpu:nanoseconds:cpu:nanoseconds' },
          label_selector: { type: 'string', description: 'Pyroscope: label selector, e.g. {service_name="checkout"}' },
          hide: { type: 'boolean', description: 'Hide this query (helper for transformations)' },
        },
      },
    },
    description: { type: 'string' },
    unit: { type: 'string', description: 'Grafana unit id: percentunit, percent, s, ms, reqps, bytes, decbytes, short, ops…' },
    min: { type: 'number' },
    max: { type: 'number' },
    decimals: { type: 'number' },
    thresholds: { type: 'array', items: { type: 'object', properties: { value: { type: ['number', 'null'] }, color: { type: 'string' } } } },
    stack: { type: 'boolean' },
    width: { type: 'number', description: 'Grid columns 1-24' },
    height: { type: 'number', description: 'Grid rows (1 row ≈ 30px)' },
    row: { type: 'string', description: 'Collapsible row/section name to group the panel under' },
    content: { type: 'string', description: 'Markdown for text panels' },
    legend: {
      type: 'object',
      description: 'Legend. table + calcs (mean, max, lastNotNull) suits latency/throughput comparisons; hidden for single series.',
      properties: { mode: { type: 'string', enum: ['list', 'table', 'hidden'] }, placement: { type: 'string', enum: ['bottom', 'right'] }, calcs: { type: 'array', items: { type: 'string' } } },
    },
    color: { type: 'string', description: "Fixed colour (green, red, #3274D9…), 'thresholds', or a scheme like continuous-GrYlRd" },
    threshold_style: { type: 'string', enum: ['line', 'area', 'off'], description: 'Show thresholds on time series (e.g. an SLO line)' },
    draw_style: { type: 'string', enum: ['line', 'bars', 'points'] },
    fill_opacity: { type: 'number' },
    line_width: { type: 'number' },
    gradient: { type: 'string', enum: ['none', 'opacity', 'hue', 'scheme'] },
    axis_label: { type: 'string' },
    log_scale: { type: 'boolean' },
    reduce: { type: 'string', description: 'Stat/gauge/bargauge/piechart reducer: lastNotNull (default), mean, max, min, sum, count' },
    sparkline: { type: 'boolean', description: 'Stat: show a sparkline (default true)' },
    color_mode: { type: 'string', enum: ['value', 'background', 'none'], description: 'Stat colouring' },
    overrides: {
      type: 'array',
      description: 'Per-series styling, e.g. errors red, a second unit on the right axis, a dashed target line.',
      items: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Series/field name, or a regex with regex: true' },
          regex: { type: 'boolean' },
          unit: { type: 'string' },
          color: { type: 'string' },
          axis: { type: 'string', enum: ['left', 'right', 'hidden'] },
          draw_style: { type: 'string', enum: ['line', 'bars', 'points'] },
          fill_opacity: { type: 'number' },
          dashed: { type: 'boolean' },
          stack: { type: 'boolean' },
          hide: { type: 'boolean' },
          display_name: { type: 'string' },
        },
        required: ['match'],
      },
    },
    mappings: {
      type: 'array',
      description: 'Value mappings, e.g. 1 → Up (green), 0 → Down (red); or ranges',
      items: { type: 'object', properties: { value: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, text: { type: 'string' }, color: { type: 'string' } }, required: ['text'] },
    },
    links: { type: 'array', description: 'Panel header links (runbooks, related dashboards; may use $variables)', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
    data_link: { type: 'object', description: 'Link on every value, e.g. to a drilldown dashboard with ${__field.labels.service}', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] },
    repeat: { type: 'string', description: 'Repeat this panel for each value of a (multi-value) variable' },
    repeat_direction: { type: 'string', enum: ['h', 'v'] },
    transformations: { type: 'array', items: { type: 'object' }, description: 'Grafana transformations (advanced), passed through' },
    interval: { type: 'string', description: 'Min interval, e.g. 1m' },
    max_data_points: { type: 'number' },
  },
  required: ['title', 'type'],
};

/** How the model should design dashboards (shared by draft_dashboard and revise_draft). */
const DESIGN_GUIDE =
  'Design like a senior SRE: (1) a top row of 3–6 stat panels with the key numbers (request rate, error %, p95 latency, saturation) using thresholds and sparklines; ' +
  '(2) sections (row) per concern in reading order: golden signals/RED or USE first, then breakdowns (by route, pod, dependency), then logs and traces; ' +
  '(3) time series for trends with units, legends ({{label}}), thresholds drawn for SLOs, overrides colouring errors red; heatmaps for latency histograms; tables or bar gauges for top-N; ' +
  '(4) variables for datasource and the main labels (service, namespace, cluster) with All, used in every query; ' +
  '(5) a short description on every panel, and panel links to runbooks or Drilldown apps where useful. ' +
  'Discover real metric names, label values and log streams before writing queries; counters need rate(...[$__rate_interval]); histograms need histogram_quantile(0.95, sum by (le) (rate(..._bucket[$__rate_interval]))). Prefer 8–20 panels; split very large dashboards.';

export function draftDashboardTool(onDraft?: (d: DashboardDraft) => void): ToolDefinition {
  return {
    schema: {
      name: 'draft_dashboard',
      description:
        'Draft a Grafana dashboard from a compact spec. The draft is shown to the user with a live preview of every panel and Save/Open buttons; it is NOT saved until the user clicks Save (always as a new dashboard, never overwriting). Every query is dry-run against the last hour and you get back which panels returned data, were empty, or errored; safe fixes (rate windows, units) are applied automatically and reported. Fix the rest, preferably with revise_draft. ' +
        DESIGN_GUIDE,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          folder_uid: { type: 'string', description: 'Target folder (from list_folders); user can change it before saving' },
          time_from: { type: 'string', description: 'Default time range start, e.g. now-6h' },
          refresh: { type: 'string', description: 'Auto-refresh, e.g. 30s, 1m' },
          extend_dashboard_uid: { type: 'string', description: 'Start from a copy of this existing dashboard and append the new panels (saved as a new dashboard)' },
          variables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: ['query', 'custom', 'datasource', 'interval', 'textbox'] },
                label: { type: 'string' },
                datasource_uid: { type: 'string' },
                query: { type: 'string', description: 'label_values(metric, label) for Prometheus/Loki query vars; comma list for custom; plugin type (prometheus/loki) for datasource vars' },
                multi: { type: 'boolean' },
                include_all: { type: 'boolean' },
              },
              required: ['name', 'type'],
            },
          },
          annotations: { type: 'array', description: 'Query annotations (e.g. deployment events from logs) drawn as markers on every graph', items: annotationSchema },
          panels: { type: 'array', items: panelSchema },
          collapsed_rows: { type: 'array', items: { type: 'string' }, description: 'Section (row) names that start collapsed (e.g. detailed breakdowns)' },
          check_queries: { type: 'boolean', description: 'Dry-run queries (default true)' },
        },
        required: ['title', 'panels'],
      },
    },
    describe: (i) => `Draft dashboard "${i.title}" (${(i.panels ?? []).length} panels)`,
    run: async (input, ctx) => {
      if (!onDraft) {
        throw new Error('dashboard drafts are not available in this context (no user interface to review them)');
      }
      const prev = ctx.latestDraft?.();
      const draft = await buildDashboardDraft(input as DashboardSpec, ctx);
      draft.revision = (prev?.revision ?? 0) + 1;
      // A fresh draft with the same title is a rewrite of the same dashboard; anything else starts a new one.
      draft.lineage = prev && prev.title === draft.title ? prev.lineage ?? prev.id : draft.id;
      onDraft(draft);
      return draftReport(draft, []);
    },
  };
}

/** What the model gets back after a draft or revision. */
export function draftReport(draft: DashboardDraft, changes: string[]): string {
  const bad = draft.checks.filter((c) => c.status === 'error' || c.status === 'empty');
  return [
    `Draft "${draft.title}"${draft.revision && draft.revision > 1 ? ` (revision ${draft.revision})` : ''} ready (${draft.outline.length} items), shown to the user with a live preview and Save/Open buttons.`,
    changes.length ? `Changes:\n- ${changes.join('\n- ')}` : '',
    'Layout:',
    ...draft.outline,
    draft.fixes?.length ? `Fixed automatically:\n- ${draft.fixes.join('\n- ')}` : '',
    draft.warnings.length ? `Warnings:\n- ${draft.warnings.join('\n- ')}` : 'Warnings: none',
    draft.checks.length
      ? `Query dry-run (last 1h, variables wildcarded): ${draft.checks.filter((c) => c.status === 'ok').length} ok, ${bad.length} need attention` +
        (bad.length ? '\n' + bad.map((c) => `- [${c.status}] ${c.panel}: ${c.query.slice(0, 200)} → ${c.detail}`).join('\n') : '')
      : 'Query dry-run skipped.',
    bad.length || draft.warnings.length
      ? 'Fix the problems above with revise_draft (only the changed panels), or explain to the user why a panel is expected to be empty.'
      : 'Tell the user the draft is ready to review and save; offer specific refinements.',
  ]
    .filter(Boolean)
    .join('\n');
}

interface ReviseInput {
  title?: string;
  description?: string;
  tags?: string[];
  time_from?: string;
  refresh?: string;
  add_panels?: Array<PanelSpec & { after?: string }>;
  update_panels?: Array<{ title: string; set: Partial<PanelSpec> }>;
  remove_panels?: string[];
  move_panels?: Array<{ title: string; after?: string; row?: string }>;
  rename_rows?: Array<{ from: string; to: string }>;
  collapse_rows?: string[];
  expand_rows?: string[];
  add_variables?: VariableSpec[];
  remove_variables?: string[];
  add_annotations?: AnnotationSpec[];
  remove_annotations?: string[];
}

/** Applies revise_draft operations to a spec. Unknown panel titles are reported, not fatal. */
export function applyRevision(spec: DashboardSpec, input: ReviseInput): { spec: DashboardSpec; changes: string[]; problems: string[] } {
  const changes: string[] = [];
  const problems: string[] = [];
  let panels = spec.panels.map((p) => ({ ...p }));
  const find = (title: string) => {
    const exact = panels.findIndex((p) => p.title === title);
    return exact >= 0 ? exact : panels.findIndex((p) => p.title.toLowerCase() === title.toLowerCase());
  };
  const next: DashboardSpec = { ...spec };
  for (const key of ['title', 'description', 'tags', 'time_from', 'refresh'] as const) {
    if (input[key] !== undefined) {
      (next as any)[key] = input[key];
      changes.push(`${key} → ${JSON.stringify(input[key])}`);
    }
  }
  for (const t of input.remove_panels ?? []) {
    const i = find(t);
    if (i < 0) {
      problems.push(`no panel titled "${t}" to remove`);
      continue;
    }
    panels.splice(i, 1);
    changes.push(`− removed "${t}"`);
  }
  for (const u of input.update_panels ?? []) {
    const i = find(u.title);
    if (i < 0) {
      problems.push(`no panel titled "${u.title}" to update`);
      continue;
    }
    panels[i] = { ...panels[i], ...u.set };
    changes.push(`~ updated "${u.title}" (${Object.keys(u.set ?? {}).join(', ')})`);
  }
  for (const m of input.move_panels ?? []) {
    const i = find(m.title);
    if (i < 0) {
      problems.push(`no panel titled "${m.title}" to move`);
      continue;
    }
    const [p] = panels.splice(i, 1);
    if (m.row !== undefined) {
      p.row = m.row || undefined;
    }
    const at = m.after ? find(m.after) : -1;
    panels.splice(at >= 0 ? at + 1 : panels.length, 0, p);
    changes.push(`↕ moved "${m.title}"${m.row ? ` to section "${m.row}"` : ''}${m.after ? ` after "${m.after}"` : ''}`);
  }
  for (const a of input.add_panels ?? []) {
    const { after, ...p } = a;
    const at = after ? find(after) : -1;
    if (after && at < 0) {
      problems.push(`no panel titled "${after}" to add after; added at the end`);
    }
    panels.splice(at >= 0 ? at + 1 : panels.length, 0, p);
    changes.push(`+ added "${p.title}" (${p.type})`);
  }
  for (const r of input.rename_rows ?? []) {
    let n = 0;
    panels = panels.map((p) => (p.row === r.from ? (n++, { ...p, row: r.to }) : p));
    n ? changes.push(`section "${r.from}" → "${r.to}"`) : problems.push(`no section named "${r.from}"`);
  }
  if (input.collapse_rows?.length || input.expand_rows?.length) {
    const set = new Set(next.collapsed_rows ?? []);
    input.collapse_rows?.forEach((r) => set.add(r));
    input.expand_rows?.forEach((r) => set.delete(r));
    next.collapsed_rows = [...set];
    changes.push(`collapsed sections: ${[...set].join(', ') || 'none'}`);
  }
  if (input.add_variables?.length || input.remove_variables?.length) {
    const removed = new Set(input.remove_variables ?? []);
    const added = input.add_variables ?? [];
    next.variables = [...(next.variables ?? []).filter((v) => !removed.has(v.name) && !added.some((a) => a.name === v.name)), ...added];
    changes.push(`variables: ${next.variables.map((v) => v.name).join(', ') || 'none'}`);
  }
  if (input.add_annotations?.length || input.remove_annotations?.length) {
    const removed = new Set(input.remove_annotations ?? []);
    const added = input.add_annotations ?? [];
    next.annotations = [...(next.annotations ?? []).filter((a) => !removed.has(a.name) && !added.some((x) => x.name === a.name)), ...added];
    changes.push(`annotations: ${next.annotations.map((a) => a.name).join(', ') || 'none'}`);
  }
  next.panels = panels;
  return { spec: next, changes, problems };
}

export function reviseDraftTool(onDraft?: (d: DashboardDraft) => void): ToolDefinition {
  return {
    schema: {
      name: 'revise_draft',
      description:
        "Change the dashboard draft in this conversation without resending it: add, update, remove or move panels, rename/collapse sections, change variables, annotations, title or time. Only the changes are needed; everything else is kept. The revised draft replaces the previous one in the user's view (with live preview) and queries are dry-run again. Use it for follow-ups like 'make latency a heatmap', 'add an errors section', 'use p99'. " +
        DESIGN_GUIDE,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          time_from: { type: 'string' },
          refresh: { type: 'string' },
          add_panels: { type: 'array', items: { ...panelSchema, properties: { ...panelSchema.properties, after: { type: 'string', description: 'Insert after the panel with this title (default: end)' } } } },
          update_panels: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string', description: 'Current panel title' }, set: { type: 'object', description: 'Panel fields to change (same shape as a panel; queries replaces all queries)' } },
              required: ['title', 'set'],
            },
          },
          remove_panels: { type: 'array', items: { type: 'string' } },
          move_panels: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' }, after: { type: 'string' }, row: { type: 'string', description: 'Move into this section ("" for none)' } }, required: ['title'] },
          },
          rename_rows: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
          collapse_rows: { type: 'array', items: { type: 'string' } },
          expand_rows: { type: 'array', items: { type: 'string' } },
          add_variables: { type: 'array', items: { type: 'object' } },
          remove_variables: { type: 'array', items: { type: 'string' } },
          add_annotations: { type: 'array', items: annotationSchema },
          remove_annotations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    describe: (i) => {
      const n = (i.add_panels?.length ?? 0) + (i.update_panels?.length ?? 0) + (i.remove_panels?.length ?? 0) + (i.move_panels?.length ?? 0);
      return `Revise dashboard draft${n ? ` (${n} panel change${n === 1 ? '' : 's'})` : ''}`;
    },
    run: async (input, ctx) => {
      if (!onDraft) {
        throw new Error('dashboard drafts are not available in this context');
      }
      const prev = ctx.latestDraft?.();
      if (!prev?.spec) {
        throw new Error('there is no dashboard draft in this conversation yet; create one with draft_dashboard');
      }
      const { spec, changes, problems } = applyRevision(prev.spec, input as ReviseInput);
      if (!changes.length) {
        throw new Error(problems.length ? problems.join('; ') : 'no changes given');
      }
      const draft = await buildDashboardDraft(spec, ctx);
      draft.revision = (prev.revision ?? 1) + 1;
      draft.lineage = prev.lineage ?? prev.id;
      onDraft(draft);
      return draftReport(draft, [...changes, ...problems.map((p) => `(not applied: ${p})`)]);
    },
  };
}
