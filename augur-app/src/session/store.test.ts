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
    store.set({ running: true });
    const listener = jest.fn();
    store.subscribe(listener);
    for (let i = 0; i < 60; i++) {
      store.set({ status: `step ${i}` });
    }
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().status).toBe('step 59'); // reads are never stale
    await new Promise((r) => setTimeout(r, 80));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies immediately outside a run, and when a run ends', () => {
    const store = getStore() as any;
    const listener = jest.fn();
    store.subscribe(listener);
    store.set({ status: 'idle' });
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ running: true });
    store.set({ status: 'working' });
    store.set({ running: false, status: '' });
    expect(listener).toHaveBeenCalledTimes(2); // the run's pending notification is folded into the final one
  });
});
