import { acquireRunLock, LockManagerLike } from './runLock';

/** A LockManager with the same exclusive, ifAvailable semantics as the browser's. */
function fakeLocks(): LockManagerLike & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    async request(name, { ifAvailable }, cb) {
      if (held.has(name)) {
        if (!ifAvailable) {
          throw new Error('blocking requests not used');
        }
        return cb(null);
      }
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

beforeEach(() => localStorage.clear());

describe('run lock (Web Locks)', () => {
  it('only one of two tabs acquiring at the same time gets the conversation', async () => {
    const locks = fakeLocks(); // one origin-wide lock manager shared by both tabs
    const [a, b] = await Promise.all([acquireRunLock('s1', 'tabA', locks), acquireRunLock('s1', 'tabB', locks)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(locks.held.has('augur-assistant-app/run/s1')).toBe(true);
  });

  it('is released for the next run, and different conversations do not block each other', async () => {
    const locks = fakeLocks();
    const a = await acquireRunLock('s1', 'tabA', locks);
    expect(await acquireRunLock('s2', 'tabB', locks)).toBeDefined();
    expect(await acquireRunLock('s1', 'tabB', locks)).toBeUndefined();
    a!.release();
    await Promise.resolve();
    expect(await acquireRunLock('s1', 'tabB', locks)).toBeDefined();
  });
});

describe('run lock (localStorage fallback)', () => {
  it('only one of two tabs racing for the same conversation proceeds', async () => {
    const results = await Promise.all([acquireRunLock('s1', 'tabA', undefined), acquireRunLock('s1', 'tabB', undefined)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses while another tab holds a fresh claim, and allows it after release', async () => {
    const a = await acquireRunLock('s1', 'tabA', undefined);
    expect(a).toBeDefined();
    expect(await acquireRunLock('s1', 'tabB', undefined)).toBeUndefined();
    a!.release();
    expect(await acquireRunLock('s1', 'tabB', undefined)).toBeDefined();
  });

  it('takes over a stale claim from a tab that went away', async () => {
    localStorage.setItem('augur-assistant-app/claim/s1', JSON.stringify({ tabId: 'gone', token: 'x', at: Date.now() - 60_000 }));
    expect(await acquireRunLock('s1', 'tabB', undefined)).toBeDefined();
  });
});
