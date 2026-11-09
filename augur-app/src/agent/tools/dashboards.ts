import { ToolDefinition } from '../types';
import { buildDashboardDraft, DashboardDraft, DashboardSpec } from '../dashboard';

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
    type: { type: 'string', enum: ['timeseries', 'stat', 'gauge', 'bargauge', 'table', 'logs', 'traces', 'barchart', 'heatmap', 'piechart', 'text'] },
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
  },
  required: ['title', 'type'],
};

export function draftDashboardTool(onDraft?: (d: DashboardDraft) => void): ToolDefinition {
  return {
    schema: {
      name: 'draft_dashboard',
      description:
        'Draft a Grafana dashboard from a compact spec. The draft is shown to the user with Save/Open buttons; it is NOT saved until the user clicks Save (always as a new dashboard, never overwriting). Every query is dry-run against the last hour and you get back which panels returned data, were empty, or errored, so fix bad queries and call again before presenting. Discover real metric/label/stream names first. Calling again replaces the previous draft.',
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
      const draft = await buildDashboardDraft(input as DashboardSpec, ctx);
      onDraft(draft);
      const bad = draft.checks.filter((c) => c.status === 'error' || c.status === 'empty');
      return [
        `Draft "${draft.title}" ready (${draft.outline.length} items). Shown to the user with Save/Open buttons.`,
        'Layout:',
        ...draft.outline,
        draft.warnings.length ? `Warnings:\n- ${draft.warnings.join('\n- ')}` : 'Warnings: none',
        draft.checks.length
          ? `Query dry-run (last 1h, variables wildcarded): ${draft.checks.filter((c) => c.status === 'ok').length} ok, ${bad.length} need attention` +
            (bad.length ? '\n' + bad.map((c) => `- [${c.status}] ${c.panel}: ${c.query.slice(0, 200)} → ${c.detail}`).join('\n') : '')
          : 'Query dry-run skipped.',
        bad.length || draft.warnings.length
          ? 'Fix the problems above and call draft_dashboard again, or explain to the user why a panel is expected to be empty.'
          : 'Tell the user the draft is ready to review and save.',
      ].join('\n');
    },
  };
}
