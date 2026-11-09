import { DataSourceInfo, GrafanaHttp, ToolContext } from './types';

export const NOW = Date.parse('2026-11-09T12:00:00Z');

export const DATASOURCES: DataSourceInfo[] = [
  { uid: 'mimir', name: 'Mimir', type: 'prometheus', isDefault: true },
  { uid: 'loki', name: 'Loki', type: 'loki' },
  { uid: 'tempo', name: 'Tempo', type: 'tempo' },
];

export interface Call {
  method: 'GET' | 'POST';
  url: string;
  params?: Record<string, unknown>;
  body?: any;
}

/** Fake Grafana HTTP API driven by a route function. */
export function fakeHttp(route: (c: Call) => unknown): GrafanaHttp & { calls: Call[] } {
  const calls: Call[] = [];
  const handle = async (c: Call) => {
    calls.push(c);
    const r = route(c);
    if (r instanceof Error) {
      throw r;
    }
    return r as any;
  };
  return {
    calls,
    get: (url, params) => handle({ method: 'GET', url, params }),
    post: (url, body) => handle({ method: 'POST', url, body }),
  };
}

export function ctxWith(http: GrafanaHttp, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    http,
    listDataSources: () => DATASOURCES,
    timeRange: { from: NOW - 3600_000, to: NOW },
    now: () => NOW,
    signal: new AbortController().signal,
    ...extra,
  };
}

/** Builds a /api/ds/query response with one numeric series per labels object. */
export function seriesResponse(series: Array<{ labels: Record<string, string>; values: number[] }>, refId = 'A') {
  return {
    results: {
      [refId]: {
        frames: series.map((s) => ({
          schema: {
            fields: [
              { name: 'Time', type: 'time' },
              { name: 'Value', type: 'number', labels: s.labels },
            ],
          },
          data: { values: [s.values.map((_, i) => NOW - (s.values.length - i) * 60_000), s.values] },
        })),
      },
    },
  };
}

export function logsResponse(lines: Array<{ t: number; line: string; labels: Record<string, string> }>) {
  return {
    results: {
      A: {
        frames: [
          {
            schema: {
              meta: { type: 'log-lines' },
              fields: [
                { name: 'labels', type: 'other' },
                { name: 'Time', type: 'time' },
                { name: 'Line', type: 'string' },
              ],
            },
            data: { values: [lines.map((l) => l.labels), lines.map((l) => l.t), lines.map((l) => l.line)] },
          },
        ],
      },
    },
  };
}
