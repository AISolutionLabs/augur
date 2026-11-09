import { getBackendSrv, getDataSourceSrv, FetchError } from '@grafana/runtime';
import { Observable } from 'rxjs';
import { DataSourceInfo, GrafanaHttp, MessagesRequest, MessagesResponse, ModelCaller } from './agent/types';
import { CLAUDE_DS_TYPE } from './constants';

/**
 * Runs fn with an abort handler that is removed again as soon as the operation settles, so a
 * long-lived AbortSignal (one per multi-minute investigation) doesn't accumulate listeners.
 */
export function withAbort<T>(signal: AbortSignal | undefined, start: (settle: { resolve: (v: T) => void; reject: (e: unknown) => void }) => () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let cancel: (() => void) | undefined;
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        cancel?.();
        reject(new DOMException('Aborted', 'AbortError'));
      }
    };
    const done = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn(...a);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    cancel = start({ resolve: done(resolve), reject: done(reject) });
    if (settled) {
      cancel();
    }
  });
}

function toPromise<T>(obs: Observable<{ data: T }>, signal?: AbortSignal): Promise<T> {
  return withAbort<T>(signal, ({ resolve, reject }) => {
    const sub = obs.subscribe({ next: (r) => resolve(r.data), error: reject });
    return () => sub.unsubscribe();
  });
}

/** Grafana HTTP API as the signed-in user (session cookie); errors are returned to the agent, not toasted. */
export const grafanaHttp: GrafanaHttp = {
  get: (url, params, signal) =>
    toPromise(getBackendSrv().fetch({ url, method: 'GET', params: clean(params), showErrorAlert: false, showSuccessAlert: false }), signal),
  post: (url, body, signal, headers) =>
    toPromise(getBackendSrv().fetch({ url, method: 'POST', data: body, headers, showErrorAlert: false, showSuccessAlert: false }), signal),
};

/** Drops empty query parameters (undefined, null, ''), keeping the value types. */
export function clean<P extends Record<string, unknown>>(params?: P): Partial<P> | undefined {
  if (!params) {
    return undefined;
  }
  const out: Partial<P> = {};
  for (const [k, v] of Object.entries(params) as Array<[keyof P, P[keyof P]]>) {
    if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

export function listDataSources(): DataSourceInfo[] {
  return getDataSourceSrv()
    .getList({ all: true })
    .map((d) => ({ uid: d.uid, name: d.name, type: d.type, isDefault: d.isDefault }));
}

export function listClaudeDataSources(): DataSourceInfo[] {
  return getDataSourceSrv()
    .getList({ all: true, type: CLAUDE_DS_TYPE })
    .map((d) => ({ uid: d.uid, name: d.name, type: d.type, isDefault: d.isDefault }));
}

export interface ClaudeDsConfig {
  defaultModel: string;
  models: string[];
  maxTokens: number;
  authMethod: string;
  mcpServers?: string[];
}

export function getClaudeConfig(uid: string): Promise<ClaudeDsConfig> {
  return grafanaHttp.get<ClaudeDsConfig>(`/api/datasources/uid/${encodeURIComponent(uid)}/resources/config`);
}

const RETRYABLE_STATUS = new Set([0, -1, 408, 425, 429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000];

function sleep(ms: number, signal: AbortSignal) {
  return withAbort<void>(signal, ({ resolve }) => {
    const t = setTimeout(() => resolve(), ms);
    return () => clearTimeout(t);
  });
}

/**
 * Backoff with jitter (±50%): the lead agent and up to four sub-agents may hit the same overloaded
 * gateway at once, and identical delays would make them retry in lockstep.
 */
export function jittered(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.5 + random()));
}

/**
 * Model caller that goes through the Claude datasource proxy (credentials are added server-side).
 * Transient failures (network drop after laptop sleep, 429, 5xx, overloaded) are retried with backoff.
 */
export function datasourceModelCaller(uid: string, onRetry?: (attempt: number, reason: string) => void, backoff = BACKOFF_MS): ModelCaller {
  return async (req: MessagesRequest, signal: AbortSignal): Promise<MessagesResponse> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await grafanaHttp.post<MessagesResponse>(`/api/datasources/uid/${encodeURIComponent(uid)}/resources/messages`, req, signal);
      } catch (e) {
        if (signal.aborted) {
          throw e;
        }
        const fe = e as FetchError<any>;
        const status = typeof fe?.status === 'number' ? fe.status : 0;
        const msg = fe?.data?.error?.message ?? fe?.data?.message ?? (e as Error)?.message ?? 'request failed';
        if (RETRYABLE_STATUS.has(status) && attempt < backoff.length && !/prompt is too long|context/i.test(msg)) {
          onRetry?.(attempt + 1, status ? `HTTP ${status}` : 'network error');
          await sleep(jittered(backoff[attempt]), signal);
          continue;
        }
        throw new Error(`${status > 0 ? `HTTP ${status}: ` : ''}${msg}`);
      }
    }
  };
}
