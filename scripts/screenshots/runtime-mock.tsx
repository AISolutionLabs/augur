// Stand-in for @grafana/runtime so the real Augur components can render outside Grafana.
// Every HTTP call is answered by the scripted demo backend in demo.ts.
import React from 'react';
import { from, of, throwError } from 'rxjs';
import { handle } from './demo';

export const config = {
  bootData: { user: { login: 'anirudh', orgRole: 'Editor' } },
  buildInfo: { version: '12.2.0' },
  theme2: undefined,
};

export const locationService = { push: () => undefined, getLocation: () => window.location };

export function PluginPage({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 24 }}>{children}</div>;
}

export function getBackendSrv() {
  return {
    fetch: (opts: { url: string; method: string; data?: unknown; params?: Record<string, unknown> }) => {
      try {
        const r = handle(opts);
        if (r instanceof Promise) {
          return from(r.then((data) => ({ data })));
        }
        return of({ data: r });
      } catch (e) {
        return throwError(() => e);
      }
    },
  };
}

const DATASOURCES = [
  { uid: 'claude', name: 'Claude', type: 'augur-claude-datasource', isDefault: false },
  { uid: 'mimir', name: 'Mimir prod', type: 'prometheus', isDefault: true },
  { uid: 'loki', name: 'Loki prod', type: 'loki', isDefault: false },
  { uid: 'tempo', name: 'Tempo prod', type: 'tempo', isDefault: false },
  { uid: 'pyro', name: 'Pyroscope', type: 'grafana-pyroscope-datasource', isDefault: false },
];

export function getDataSourceSrv() {
  return {
    getList: (f?: { type?: string }) => (f?.type ? DATASOURCES.filter((d) => d.type === f.type) : DATASOURCES),
  };
}

export type FetchError<T = unknown> = { status: number; data: T };
