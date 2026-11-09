import { getBackendSrv, getDataSourceSrv, FetchError } from '@grafana/runtime';
import { Observable } from 'rxjs';
import { DataSourceInfo, GrafanaHttp, MessagesRequest, MessagesResponse, ModelCaller } from './agent/types';
import { CLAUDE_DS_TYPE } from './constants';

function toPromise<T>(obs: Observable<{ data: T }>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const sub = obs.subscribe({
      next: (r) => resolve(r.data),
      error: (e) => reject(e),
    });
    signal?.addEventListener(
      'abort',
      () => {
        sub.unsubscribe();
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/** Grafana HTTP API as the signed-in user (session cookie); errors are returned to the agent, not toasted. */
export const grafanaHttp: GrafanaHttp = {
  get: (url, params, signal) =>
    toPromise(getBackendSrv().fetch({ url, method: 'GET', params: clean(params), showErrorAlert: false, showSuccessAlert: false }), signal),
  post: (url, body, signal, headers) =>
    toPromise(getBackendSrv().fetch({ url, method: 'POST', data: body, headers, showErrorAlert: false, showSuccessAlert: false }), signal),
};

function clean(params?: Record<string, unknown>) {
  if (!params) {
    return undefined;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
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

/** Model caller that goes through the Claude datasource proxy (credentials are added server-side). */
export function datasourceModelCaller(uid: string): ModelCaller {
  return async (req: MessagesRequest, signal: AbortSignal): Promise<MessagesResponse> => {
    try {
      return await grafanaHttp.post<MessagesResponse>(`/api/datasources/uid/${encodeURIComponent(uid)}/resources/messages`, req, signal);
    } catch (e) {
      const fe = e as FetchError<any>;
      const msg = fe?.data?.error?.message ?? fe?.data?.message;
      if (msg) {
        throw new Error(`${fe.status ? `HTTP ${fe.status}: ` : ''}${msg}`);
      }
      throw e;
    }
  };
}
