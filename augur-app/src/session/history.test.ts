import { deleteSession, isDeleted, loadCurrent, loadHistory, persist, SessionState, setCurrent, setHistoryRetentionDays } from './history';

const DAY = 86_400_000;
const conv = (id: string, ageDays: number, extra: Partial<SessionState> = {}): SessionState => ({
  id,
  title: id,
  mode: 'chat',
  rangeKey: '1h',
  createdAt: Date.now() - ageDays * DAY,
  updatedAt: Date.now() - ageDays * DAY,
  items: [{ kind: 'user', text: id, mode: 'chat' }],
  messages: [],
  proposals: {},
  findings: [],
  hypotheses: [],
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  setHistoryRetentionDays(undefined);
});

describe('deleted conversations', () => {
  it('cannot be written back by a late save, and stop being current', () => {
    persist(conv('a', 0));
    setCurrent('a');
    deleteSession('a');
    expect(isDeleted('a')).toBe(true);
    expect(loadCurrent()).toBeUndefined();
    persist(conv('a', 0)); // e.g. the run's finally block, or another tab
    expect(loadHistory().map((s) => s.id)).toEqual([]);
    persist(conv('b', 0));
    expect(loadHistory().map((s) => s.id)).toEqual(['b']);
  });

  it('keeps a bounded number of tombstones', () => {
    for (let i = 0; i < 520; i++) {
      deleteSession(`x${i}`);
    }
    expect(JSON.parse(localStorage.getItem('augur-assistant-app/deleted')!)).toHaveLength(500);
    expect(isDeleted('x519')).toBe(true);
  });
});

describe('retention', () => {
  it('deletes conversations older than the retention period, keeping pinned and running ones', () => {
    localStorage.setItem(
      'augur-assistant-app/history',
      JSON.stringify([conv('new', 1), conv('old', 40), conv('old-pinned', 40, { pinned: true }), conv('old-running', 40, { run: { status: 'running', mode: 'chat', startedAt: 0 } })])
    );
    setHistoryRetentionDays(30);
    expect(loadHistory().map((s) => s.id).sort()).toEqual(['new', 'old-pinned', 'old-running']);
  });

  it('keeps everything when unset', () => {
    localStorage.setItem('augur-assistant-app/history', JSON.stringify([conv('old', 400)]));
    setHistoryRetentionDays(undefined);
    persist(conv('new', 0));
    expect(loadHistory().map((s) => s.id)).toEqual(['new', 'old']);
  });
});
