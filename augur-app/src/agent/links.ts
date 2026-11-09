// Deep links into Grafana so every claim can be opened and verified.

import { DataSourceInfo } from './types';

function rangeParam(from: number | string, to: number | string) {
  return { from: String(from), to: String(to) };
}

/** Explore URL (schemaVersion 1 "panes" format, supported by Grafana 10+). */
export function exploreUrl(ds: DataSourceInfo, query: Record<string, unknown>, from: number | string, to: number | string): string {
  const panes = {
    a: {
      datasource: ds.uid,
      queries: [{ refId: 'A', datasource: { uid: ds.uid, type: ds.type }, ...query }],
      range: rangeParam(from, to),
    },
  };
  return `/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}&orgId=1`;
}

export function dashboardUrl(uid: string, opts: { panelId?: number; from?: number | string; to?: number | string } = {}): string {
  const p = new URLSearchParams();
  if (opts.from !== undefined && opts.to !== undefined) {
    p.set('from', String(opts.from));
    p.set('to', String(opts.to));
  }
  if (opts.panelId !== undefined) {
    p.set('viewPanel', String(opts.panelId));
  }
  const qs = p.toString();
  return `/d/${encodeURIComponent(uid)}${qs ? `?${qs}` : ''}`;
}

export function alertRuleUrl(uid: string): string {
  return `/alerting/grafana/${encodeURIComponent(uid)}/view`;
}

export function md(label: string, url: string): string {
  return `[${label.replace(/[[\]]/g, '')}](${url})`;
}
