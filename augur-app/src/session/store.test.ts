jest.mock('@grafana/runtime', () => ({
  config: { bootData: { user: { login: 'u', timezone: 'utc' } }, buildInfo: { version: '13.2.4' } },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  getDataSourceSrv: () => ({ getList: () => [] }),
  locationService: { push: jest.fn() },
}));

import { getStore, resetStoreForTests } from './store';

describe('store notifications', () => {
  afterEach(() => resetStoreForTests());

  it('batches a burst of updates during a run into at most one notification per frame', async () => {
    const store = getStore() as any;
    store.runs.set('r1', { sessionId: 'r1', abort: new AbortController() }); // a run in progress
    store.set({ running: true });
    const listener = jest.fn();
    store.subscribe(listener);
    for (let i = 0; i < 60; i++) {
      store.set({ status: `step ${i}` });
    }
    expect(listener).not.toHaveBeenCalled();
    // React's snapshot only moves when listeners are notified (no mid-render changes).
    expect(store.getState().status).not.toBe('step 59');
    await new Promise((r) => setTimeout(r, 80));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('step 59');
    store.runs.delete('r1');
  });

  it('notifies immediately outside a run, and when a run ends', () => {
    const store = getStore() as any;
    const listener = jest.fn();
    store.subscribe(listener);
    store.set({ status: 'idle' });
    expect(listener).toHaveBeenCalledTimes(1);
    store.runs.set('r1', { sessionId: 'r1', abort: new AbortController() });
    store.set({ status: 'working' });
    store.runs.delete('r1');
    store.set({ running: false, status: '' });
    expect(listener).toHaveBeenCalledTimes(2); // the run's pending notification is folded into the final one
  });
});

describe('history compaction', () => {
  const { compactHistory } = jest.requireActual('./history');
  const conv = (id: string, updatedAt: number, extra: any = {}) => ({
    id,
    title: id,
    mode: 'chat',
    rangeKey: '1h',
    createdAt: updatedAt,
    updatedAt,
    items: [{ kind: 'user', text: id, mode: 'chat' }, { kind: 'tool', id: 't', name: 'query_loki', label: 'x', input: {}, status: 'ok', output: 'x'.repeat(5000) }],
    messages: [{ role: 'user', content: 'y'.repeat(5000) }],
    proposals: {},
    findings: [],
    hypotheses: [],
    ...extra,
  });

  it('drops transcripts of the oldest unpinned conversations before dropping any conversation', () => {
    const list = [conv('new', 3), conv('mid', 2), conv('old', 1, { pinned: true }), conv('oldest', 0)];
    const out = compactHistory(list, JSON.stringify(list).length - 4000, 'new');
    expect(out.map((x: any) => x.id)).toEqual(['new', 'mid', 'old', 'oldest']);
    expect(out.find((x: any) => x.id === 'oldest').messages).toEqual([]);
    expect(out.find((x: any) => x.id === 'old').messages).toHaveLength(1); // pinned
    expect(out.find((x: any) => x.id === 'new').messages).toHaveLength(1); // the one being saved
  });

  it('trims tool outputs, then drops the oldest unpinned conversations, never pinned ones', () => {
    const list = [conv('new', 3), conv('mid', 2), conv('pinned', 1, { pinned: true }), conv('oldest', 0)];
    const out = compactHistory(list, 13_500, 'new');
    expect(out.map((x: any) => x.id)).toContain('pinned');
    expect(out.map((x: any) => x.id)).toContain('new');
    expect(out.map((x: any) => x.id)).not.toContain('oldest');
  });
});
