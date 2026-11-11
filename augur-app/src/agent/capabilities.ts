// What this Grafana has installed: apps, panel and datasource plugins (with versions). Augur uses it
// to know which Grafana features it can point users to, and which panel types a dashboard can use.

import { GrafanaHttp, ToolDefinition } from './types';

export interface InstalledPlugin {
  id: string;
  name: string;
  type: 'app' | 'panel' | 'datasource' | string;
  version?: string;
  description?: string;
  /** Shipped with Grafana (core) rather than installed separately. */
  core?: boolean;
}

export interface Capabilities {
  grafanaVersion?: string;
  plugins: InstalledPlugin[];
  /** Panel plugin ids available for dashboards. */
  panels: Set<string>;
  error?: string;
}

/** What well-known apps are for, so the model can send users to the right place. */
export const KNOWN_APPS: Record<string, string> = {
  'grafana-metricsdrilldown-app': 'Metrics Drilldown: queryless browsing of Prometheus metrics by label',
  'grafana-lokiexplore-app': 'Logs Drilldown: queryless log exploration, patterns and field breakdowns',
  'grafana-exploretraces-app': 'Traces Drilldown: RED metrics from spans, breakdowns, comparisons, root-cause views',
  'grafana-pyroscope-app': 'Profiles Drilldown: flame graphs and profile comparisons',
  'grafana-k8s-app': 'Kubernetes Monitoring: clusters, workloads, cost, alerts',
  'grafana-app-observability-app': 'Application Observability: service inventory and RED metrics from OpenTelemetry',
  'grafana-kowalski-app': 'Frontend Observability: web vitals, sessions and JS errors',
  'grafana-irm-app': 'IRM: on-call schedules, escalations, incidents',
  'grafana-oncall-app': 'OnCall: on-call schedules and escalations',
  'grafana-incident-app': 'Incident: incident timelines and coordination',
  'grafana-slo-app': 'SLO: service level objectives, error budgets, burn-rate alerts',
  'grafana-synthetic-monitoring-app': 'Synthetic Monitoring: uptime and API checks from probes',
  'k6-app': 'k6: load and performance tests',
  'grafana-k6-app': 'k6: load and performance tests',
  'grafana-asserts-app': 'Asserts: entity graph and automated insights',
  'grafana-ml-app': 'Machine Learning: forecasts, outlier detection, Sift investigations',
  'grafana-adaptive-metrics-app': 'Adaptive Metrics: cardinality and cost optimisation',
  'grafana-adaptivelogs-app': 'Adaptive Logs: log volume optimisation',
  'grafana-llm-app': 'LLM plugin: shared LLM access for Grafana features',
  'grafana-assistant-app': "Grafana Assistant: Grafana Labs' AI assistant",
  'grafana-csp-app': 'Cloud Provider Observability: AWS/Azure/GCP services',
  'grafana-dbo11y-app': 'Database Observability: query performance',
};

/** Panel ids Grafana always ships (used when the plugin list cannot be read). */
export const CORE_PANELS = [
  'timeseries',
  'stat',
  'gauge',
  'bargauge',
  'table',
  'logs',
  'traces',
  'barchart',
  'heatmap',
  'piechart',
  'text',
  'state-timeline',
  'status-history',
  'histogram',
  'flamegraph',
  'nodeGraph',
  'geomap',
  'xychart',
  'trend',
  'canvas',
  'news',
  'dashlist',
  'alertlist',
  'annolist',
];

interface PluginListEntry {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
  signature?: string;
  signatureType?: string;
  info?: { version?: string; description?: string };
}

export async function loadCapabilities(http: GrafanaHttp, grafanaVersion?: string, signal?: AbortSignal): Promise<Capabilities> {
  try {
    const list = await http.get<PluginListEntry[]>('/api/plugins', { enabled: 1 }, signal);
    const plugins = (Array.isArray(list) ? list : [])
      .filter((p) => p.enabled !== false)
      .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        version: p.info?.version || undefined,
        description: p.info?.description || undefined,
        core: p.signature === 'internal',
      }));
    const panels = new Set(plugins.filter((p) => p.type === 'panel').map((p) => p.id));
    return { grafanaVersion, plugins, panels: panels.size ? panels : new Set(CORE_PANELS) };
  } catch (e) {
    return { grafanaVersion, plugins: [], panels: new Set(CORE_PANELS), error: (e as Error)?.message ?? 'could not list plugins' };
  }
}

/** Compact section for the system prompt. */
export function capabilitiesSummary(c: Capabilities | undefined): string {
  if (!c || (!c.plugins.length && !c.grafanaVersion)) {
    return '';
  }
  const apps = c.plugins.filter((p) => p.type === 'app' && !p.id.includes('augur'));
  const extraPanels = c.plugins.filter((p) => p.type === 'panel' && !p.core);
  const lines = [`\nInstalled in this Grafana${c.grafanaVersion ? ` (${c.grafanaVersion})` : ''} (details: grafana_capabilities):`];
  if (apps.length) {
    lines.push('- Apps (link users to them at /a/<id> when they fit the task better than a query):');
    for (const a of apps) {
      lines.push(`  - ${a.name} (${a.id}${a.version ? ` ${a.version}` : ''})${KNOWN_APPS[a.id] ? `: ${KNOWN_APPS[a.id]}` : ''}`);
    }
  } else if (c.plugins.length) {
    lines.push('- No apps installed besides Augur.');
  }
  if (c.panels.size) {
    lines.push(`- Panel types for dashboards: ${[...c.panels].sort().join(', ')}`);
  }
  if (extraPanels.length) {
    lines.push(`- Non-core panel plugins: ${extraPanels.map((p) => `${p.id}${p.version ? ` ${p.version}` : ''}`).join(', ')}`);
  }
  return lines.join('\n');
}

export function capabilitiesTool(get: () => Promise<Capabilities>): ToolDefinition {
  return {
    readOnly: true,
    schema: {
      name: 'grafana_capabilities',
      description:
        'What this Grafana has installed: Grafana version, app plugins (Drilldown apps, IRM, SLO, k6…), datasource plugins and panel types, with versions and descriptions. Use it to tell users what Grafana features they can use, or before choosing panel types.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['app', 'panel', 'datasource'], description: 'Only this plugin type' },
          query: { type: 'string', description: 'Filter by id or name substring' },
        },
      },
    },
    describe: (i) => `Grafana capabilities${i.type ? ` (${i.type})` : ''}`,
    run: async (input) => {
      const c = await get();
      const q = String(input.query ?? '').toLowerCase();
      const rows = c.plugins
        .filter((p) => !input.type || p.type === input.type)
        .filter((p) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
        .map((p) => `${p.type} | ${p.id} | ${p.name}${p.version ? ` | ${p.version}` : ''}${p.core ? ' | core' : ''}${KNOWN_APPS[p.id] ? ` | ${KNOWN_APPS[p.id]}` : p.description ? ` | ${p.description.slice(0, 120)}` : ''}`);
      return [
        `Grafana ${c.grafanaVersion ?? '(version unknown)'}`,
        c.error ? `Could not read the plugin list (${c.error}); panel types assumed to be the core set.` : '',
        rows.length ? `type | id | name | version | notes\n${rows.join('\n')}` : 'No matching plugins.',
      ]
        .filter(Boolean)
        .join('\n');
    },
  };
}
