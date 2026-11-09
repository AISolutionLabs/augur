import { of, Subject, throwError } from 'rxjs';

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

import { clean, datasourceModelCaller, jittered, withAbort } from './api';

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


test('abort listeners are removed when operations settle (no accumulation on a long-lived signal)', async () => {
  const ac = new AbortController();
  const added = jest.spyOn(ac.signal, 'addEventListener');
  const removed = jest.spyOn(ac.signal, 'removeEventListener');
  responses.push({ error: { status: 503 } }, ok);
  for (let i = 0; i < 25; i++) {
    responses.push(ok);
  }
  const call = datasourceModelCaller('claude', undefined, [1]);
  await call({ messages: [] }, ac.signal); // one retry + sleep, then success
  for (let i = 0; i < 25; i++) {
    await call({ messages: [] }, ac.signal);
  }
  expect(added.mock.calls.length).toBeGreaterThan(25);
  expect(removed.mock.calls.length).toBe(added.mock.calls.length);
});

test('aborting cancels the in-flight operation exactly once', async () => {
  const ac = new AbortController();
  const subject = new Subject<number>();
  let cancelled = 0;
  const p = withAbort<number>(ac.signal, ({ resolve }) => {
    const sub = subject.subscribe((v) => resolve(v));
    return () => {
      cancelled++;
      sub.unsubscribe();
    };
  });
  ac.abort();
  await expect(p).rejects.toThrow('Aborted');
  subject.next(1);
  expect(cancelled).toBe(1);
  // Synchronous completion inside start() still cleans up.
  const sync = withAbort<number>(ac.signal, () => () => undefined);
  await expect(sync).rejects.toThrow('Aborted');
});

test('backoff jitter stays within ±50% and clean() drops only empty values', () => {
  expect(jittered(1000, () => 0)).toBe(500);
  expect(jittered(1000, () => 0.999)).toBe(1499);
  const c = clean({ a: 1, b: undefined, c: null, d: '', e: 0, f: false });
  expect(c).toEqual({ a: 1, e: 0, f: false });
});
