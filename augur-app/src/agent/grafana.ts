// Helpers for talking to Grafana's HTTP API as the signed-in user.

import { DataSourceInfo, ToolContext } from './types';
import { DsQueryResponse } from './frames';

export const PROM_TYPES = ['prometheus']; // Mimir, Cortex and Thanos all use the prometheus datasource type
export const LOKI_TYPES = ['loki'];
export const TEMPO_TYPES = ['tempo'];

export function findDataSource(ctx: ToolContext, uid: string, allowedTypes?: string[]): DataSourceInfo {
  if (!uid) {
    throw new Error('datasource_uid is required. Call list_datasources to find it.');
  }
  const all = ctx.listDataSources();
  const ds = all.find((d) => d.uid === uid) ?? all.find((d) => d.name === uid);
  if (!ds) {
    throw new Error(`datasource "${uid}" not found or not visible to you. Call list_datasources.`);
  }
  if (allowedTypes && !allowedTypes.includes(ds.type)) {
    throw new Error(`datasource "${ds.name}" is type ${ds.type}; this tool needs ${allowedTypes.join(' or ')}`);
  }
  return ds;
}

/** Runs queries through Grafana's unified query API (the same path panels use). */
export async function dsQuery(
  ctx: ToolContext,
  ds: DataSourceInfo,
  query: Record<string, unknown>,
  range: { from: number; to: number }
): Promise<DsQueryResponse> {
  return ctx.http.post<DsQueryResponse>(
    '/api/ds/query',
    {
      queries: [{ refId: 'A', datasource: { uid: ds.uid, type: ds.type }, ...query }],
      from: String(range.from),
      to: String(range.to),
    },
    ctx.signal
  );
}

/** GET against a datasource's resource API (label/metric discovery). */
export function dsResource<T = unknown>(ctx: ToolContext, ds: DataSourceInfo, path: string, params?: Record<string, unknown>) {
  return ctx.http.get<T>(`/api/datasources/uid/${encodeURIComponent(ds.uid)}/resources/${path}`, params, ctx.signal);
}

/** Extracts a readable message from backendSrv / fetch errors. */
export function errorMessage(e: unknown): string {
  const anyE = e as any;
  if (anyE?.data) {
    const d = anyE.data;
    const msg = d.message ?? d.error?.message ?? d.error ?? (d.results ? JSON.stringify(d.results).slice(0, 500) : undefined);
    if (msg) {
      return `${anyE.status ? `HTTP ${anyE.status}: ` : ''}${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
    }
  }
  if (anyE?.status) {
    return `HTTP ${anyE.status}${anyE.statusText ? ' ' + anyE.statusText : ''}`;
  }
  return anyE?.message ?? String(e);
}
