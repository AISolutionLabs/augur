import { of, throwError } from 'rxjs';

const responses: any[] = [];
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    fetch: () => {
      const r = responses.shift();
      return r?.error ? throwError(() => r.error) : of({ data: r });
    },
  }),
  getDataSourceSrv: () => ({ getList: () => [] }),
}));

import { datasourceModelCaller } from './api';

const ok = { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'end_turn' };

test('retries transient gateway failures with backoff, then succeeds', async () => {
  responses.push({ error: { status: 503, data: { error: { message: 'overloaded' } } } }, { error: { status: 0 } }, ok);
  const retries: string[] = [];
  const call = datasourceModelCaller('claude', (n, why) => retries.push(`${n}:${why}`), [1, 1, 1, 1]);
  await expect(call({ messages: [] }, new AbortController().signal)).resolves.toMatchObject({ id: 'm' });
  expect(retries).toEqual(['1:HTTP 503', '2:network error']);
});

test('does not retry client errors or context overflow, and gives up after the last attempt', async () => {
  responses.push({ error: { status: 401, data: { error: { message: 'no OAuth token' } } } });
  const call = datasourceModelCaller('claude', undefined, [1, 1]);
  await expect(call({ messages: [] }, new AbortController().signal)).rejects.toThrow('HTTP 401: no OAuth token');
  responses.push({ error: { status: 400, data: { error: { message: 'prompt is too long: 250000 tokens' } } } });
  await expect(call({ messages: [] }, new AbortController().signal)).rejects.toThrow(/prompt is too long/);
  responses.push({ error: { status: 502 } }, { error: { status: 502 } }, { error: { status: 502, data: { message: 'bad gateway' } } });
  await expect(call({ messages: [] }, new AbortController().signal)).rejects.toThrow('HTTP 502: bad gateway');
});
