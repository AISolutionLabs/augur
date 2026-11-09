// Deterministic infrastructure scan: discovers services, namespaces and dependencies from the
// LGTM datasources a user can see. No model calls, so it is cheap and repeatable.

import { DataSourceInfo, GrafanaHttp } from './types';
import { InfraMemory, ServiceEntry } from '../settings';
import { framesOf, DsQueryResponse } from './frames';

const SERVICE_LABELS = ['service_name', 'service', 'app', 'app_kubernetes_io_name', 'job'];
const RED_METRICS = [
  'traces_spanmetrics_calls_total',
  'traces_span_metrics_calls_total',
  'http_server_request_duration_seconds_count',
  'http_server_duration_milliseconds_count',
  'http_requests_total',
  'grpc_server_handled_total',
  'kube_pod_info',
  'container_cpu_usage_seconds_total',
  'node_cpu_seconds_total',
];

type Progress = (msg: string) => void;

async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export async function scanInfrastructure(
  http: GrafanaHttp,
  datasources: DataSourceInfo[],
  opts: { user?: string; now?: number; onProgress?: Progress } = {}
): Promise<InfraMemory> {
  const now = opts.now ?? Date.now();
  const progress = opts.onProgress ?? (() => undefined);
  const services = new Map<string, ServiceEntry>();
  const addService = (name: string, source: string, ns?: string) => {
    if (!name || name.length > 120) {
      return;
    }
    const e = services.get(name) ?? { name, sources: [], namespaces: [] };
    if (!e.sources.includes(source)) {
      e.sources.push(source);
    }
    if (ns && !e.namespaces!.includes(ns)) {
      e.namespaces!.push(ns);
    }
    services.set(name, e);
  };
  const edges = new Map<string, { client: string; server: string; rps?: number; errorRate?: number }>();
  const dsNotes: InfraMemory['datasources'] = [];
  const start = Math.floor((now - 6 * 3600_000) / 1000);
  const end = Math.floor(now / 1000);

  for (const ds of datasources.filter((d) => d.type === 'prometheus')) {
    progress(`Scanning metrics in ${ds.name}…`);
    const base = `/api/datasources/uid/${encodeURIComponent(ds.uid)}/resources/api/v1`;
    const notes: string[] = [];
    const names = (await safe(http.get<{ data?: string[] }>(`${base}/label/__name__/values`, { start, end })))?.data ?? [];
    notes.push(`${names.length} metric names`);
    const present = RED_METRICS.filter((m) => names.includes(m));
    if (present.length) {
      notes.push(`has ${present.join(', ')}`);
    }
    for (const label of SERVICE_LABELS) {
      const vals = (await safe(http.get<{ data?: string[] }>(`${base}/label/${label}/values`, { start, end })))?.data ?? [];
      if (vals.length && vals.length <= 1000) {
        notes.push(`service label "${label}" (${vals.length} values)`);
        vals.slice(0, 400).forEach((v) => addService(v, `metrics:${ds.name}(${label})`));
        if (label !== 'job') {
          break; // first service-like label wins; job is a fallback
        }
      }
    }
    const nss = (await safe(http.get<{ data?: string[] }>(`${base}/label/namespace/values`, { start, end })))?.data ?? [];
    if (nss.length) {
      notes.push(`namespaces: ${nss.slice(0, 40).join(', ')}${nss.length > 40 ? '…' : ''}`);
    }
    if (names.includes('traces_service_graph_request_total')) {
      progress(`Reading service graph from ${ds.name}…`);
      const q = async (expr: string) =>
        safe(
          http.post<DsQueryResponse>('/api/ds/query', {
            queries: [{ refId: 'A', datasource: { uid: ds.uid, type: ds.type }, expr, instant: true, range: false }],
            from: String(now - 3600_000),
            to: String(now),
          })
        );
      const total = await q('sum by (client, server) (rate(traces_service_graph_request_total[1h]))');
      const failed = await q('sum by (client, server) (rate(traces_service_graph_request_failed_total[1h]))');
      const read = (r?: DsQueryResponse) => {
        const out = new Map<string, number>();
        try {
          for (const f of framesOf(r ?? {})) {
            for (const field of f.schema?.fields ?? []) {
              if (field.type === 'number' && field.labels?.client && field.labels?.server) {
                const idx = (f.schema?.fields ?? []).indexOf(field);
                const vals = (f.data?.values?.[idx] ?? []) as number[];
                out.set(`${field.labels.client}→${field.labels.server}`, Number(vals[vals.length - 1] ?? 0));
              }
            }
          }
        } catch {
          // ignore
        }
        return out;
      };
      const t = read(total);
      const fl = read(failed);
      for (const [k, rps] of t) {
        const [client, server] = k.split('→');
        edges.set(k, { client, server, rps, errorRate: rps > 0 ? (fl.get(k) ?? 0) / rps : undefined });
        addService(client, `traces-graph:${ds.name}`);
        addService(server, `traces-graph:${ds.name}`);
      }
      notes.push(`service graph: ${t.size} edges`);
    }
    dsNotes.push({ uid: ds.uid, name: ds.name, type: ds.type, notes });
  }

  for (const ds of datasources.filter((d) => d.type === 'loki')) {
    progress(`Scanning log streams in ${ds.name}…`);
    const base = `/api/datasources/uid/${encodeURIComponent(ds.uid)}/resources`;
    const params = { start: (now - 6 * 3600_000) * 1e6, end: now * 1e6 };
    const labels = (await safe(http.get<{ data?: string[] }>(`${base}/labels`, params)))?.data ?? [];
    const notes = [`labels: ${labels.slice(0, 30).join(', ')}`];
    const svcLabel = ['service_name', 'app', 'service', 'job'].find((l) => labels.includes(l));
    if (svcLabel) {
      const vals = (await safe(http.get<{ data?: string[] }>(`${base}/label/${svcLabel}/values`, params)))?.data ?? [];
      vals.slice(0, 400).forEach((v) => addService(v, `logs:${ds.name}(${svcLabel})`));
      notes.push(`service label "${svcLabel}" (${vals.length} values)`);
    }
    if (labels.includes('level') || labels.includes('detected_level')) {
      notes.push(`level label: ${labels.includes('level') ? 'level' : 'detected_level'}`);
    }
    dsNotes.push({ uid: ds.uid, name: ds.name, type: ds.type, notes });
  }

  for (const ds of datasources.filter((d) => d.type === 'tempo')) {
    progress(`Scanning traces in ${ds.name}…`);
    const r = await safe(
      http.get<{ tagValues?: Array<{ value: string } | string> }>(
        `/api/datasources/uid/${encodeURIComponent(ds.uid)}/resources/api/v2/search/tag/resource.service.name/values`,
        { start, end }
      )
    );
    const vals = (r?.tagValues ?? []).map((v) => (typeof v === 'string' ? v : v.value));
    vals.slice(0, 400).forEach((v) => addService(v, `traces:${ds.name}`));
    dsNotes.push({ uid: ds.uid, name: ds.name, type: ds.type, notes: [`${vals.length} services with traces`] });
  }

  for (const ds of datasources.filter((d) => d.type.includes('pyroscope'))) {
    dsNotes.push({ uid: ds.uid, name: ds.name, type: ds.type, notes: ['continuous profiling available'] });
  }

  const list = [...services.values()].sort((a, b) => b.sources.length - a.sources.length || a.name.localeCompare(b.name));
  const multi = list.filter((s) => s.sources.length > 1);
  const summary = [
    `Environment: ${list.length} services discovered (${multi.length} with telemetry in more than one signal).`,
    ...dsNotes.map((d) => `- ${d.type} "${d.name}" (uid ${d.uid}): ${d.notes.join('; ')}`),
    edges.size ? `Service graph has ${edges.size} dependency edges (use get_infrastructure_memory).` : '',
    multi.length ? `Well-instrumented services: ${multi.slice(0, 30).map((s) => s.name).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    scannedAt: now,
    scannedBy: opts.user,
    summary: summary.slice(0, 4000),
    services: list.slice(0, 1500),
    edges: [...edges.values()].sort((a, b) => (b.rps ?? 0) - (a.rps ?? 0)).slice(0, 1500),
    datasources: dsNotes,
  };
}
