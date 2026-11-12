let mockFetch: (opts: { url: string }) => unknown = () => undefined;
jest.mock('@grafana/runtime', () => ({
  config: { bootData: { user: { login: 'u', timezone: 'utc' } }, buildInfo: { version: '13.2.4' } },
  getBackendSrv: () => ({ fetch: (o: { url: string }) => mockFetch(o) }),
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

describe('investigation report metadata', () => {
  const { investigationReportMeta } = jest.requireActual('./store');
  const H = 3_600_000;
  const t0 = Date.UTC(2026, 10, 12, 8);
  const base = {
    id: 's',
    title: 'morning chat',
    mode: 'investigate',
    rangeKey: '1h',
    createdAt: t0,
    updatedAt: t0 + 5 * H,
    items: [
      { kind: 'user', text: 'what dashboards do we have?', mode: 'chat' },
      { kind: 'assistant', text: 'A few.' },
      { kind: 'user', text: 'checkout errors spiked', mode: 'investigate' },
      { kind: 'assistant', text: '## Root cause\nDeploy.' },
    ],
    messages: [],
    proposals: {},
    findings: [],
    hypotheses: [],
  };

  it('uses the question and window of the investigation, not the conversation start', () => {
    const s = { ...base, investigation: { question: 'checkout errors spiked', startedAt: t0 + 5 * H, range: { from: t0 + 4 * H, to: t0 + 5 * H } } };
    const m = investigationReportMeta(s, t0 + 6 * H);
    expect(m.question).toBe('checkout errors spiked');
    expect(m.title).toBe('Investigation: checkout errors spiked');
    expect(m.range).toEqual({ from: t0 + 4 * H, to: t0 + 5 * H });
    expect(m.finalAnswer).toBe('## Root cause\nDeploy.');
  });

  it('widens the window to cover every query in the evidence ledger', () => {
    const s = {
      ...base,
      investigation: { question: 'q', startedAt: t0 + 5 * H, range: { from: t0 + 4 * H, to: t0 + 5 * H } },
      evidence: [{ id: 'E1', from: new Date(t0 + 1 * H).toISOString(), to: new Date(t0 + 5 * H + 60_000).toISOString() }],
    };
    expect(investigationReportMeta(s, t0 + 6 * H).range).toEqual({ from: t0 + 1 * H, to: t0 + 5 * H + 60_000 });
  });

  it('falls back to the last investigate question for conversations saved before 1.7', () => {
    const m = investigationReportMeta(base, t0 + 6 * H);
    expect(m.question).toBe('checkout errors spiked');
    expect(m.range.to).toBe(t0 + 5 * H);
  });
});

describe('switching datasources', () => {
  afterEach(() => resetStoreForTests());

  it('a slow response for the previously selected datasource never overwrites the current one', async () => {
    const { Subject } = jest.requireActual('rxjs');
    const pending: Record<string, any> = {};
    mockFetch = (o) => {
      const m = /uid\/([^/]+)\/resources\/(config|mcp\/tools)/.exec(o.url);
      const key = m ? `${m[1]}:${m[2]}` : o.url;
      return (pending[key] = new Subject());
    };
    const reply = (key: string, data: unknown) => {
      pending[key].next({ data });
      pending[key].complete();
    };
    const store = getStore() as any;
    store.setDsUid('a');
    store.setDsUid('b');
    reply('b:config', { defaultModel: 'model-b', models: ['model-b'], mcpServers: ['wiki'] });
    await new Promise((r) => setTimeout(r, 0));
    reply('a:config', { defaultModel: 'model-a', models: ['model-a'], mcpServers: ['other'] });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().dsConfig.defaultModel).toBe('model-b');
    expect(store.getState().model).toBe('model-b');
    // The MCP catalog of the old selection is discarded too.
    reply('b:mcp/tools', { servers: [{ name: 'wiki', tools: [] }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().mcp.servers.map((x: any) => x.name)).toEqual(['wiki']);
  });
});
