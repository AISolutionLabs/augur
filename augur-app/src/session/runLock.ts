// Cross-tab mutual exclusion for conversation runs.
//
// Two tabs must never drive the same conversation: they would duplicate model calls and MCP
// operations and overwrite each other's checkpoints. The Web Locks API gives an atomic, per-origin
// lock that the browser releases if the tab crashes or closes. Where it is missing (old browsers,
// some embedded webviews) a localStorage claim is written and then re-read after a short delay:
// of two tabs racing, only the last writer sees its own claim, so at most one proceeds.

export interface RunLock {
  release(): void;
}

/** The subset of LockManager used here (lets tests supply their own). */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

export const LOCK_PREFIX = 'augur-assistant-app/run/';
const CLAIM_PREFIX = 'augur-assistant-app/claim/';
const CLAIM_SETTLE_MS = 60;
const CLAIM_TTL_MS = 15_000;

function defaultLocks(): LockManagerLike | undefined {
  try {
    return typeof navigator !== 'undefined' && (navigator as Navigator & { locks?: LockManagerLike }).locks ? (navigator as any).locks : undefined;
  } catch {
    return undefined;
  }
}

/** Takes the run lock for a conversation, or resolves undefined if another tab holds it. */
export function acquireRunLock(sessionId: string, tabId: string, locks: LockManagerLike | undefined = defaultLocks()): Promise<RunLock | undefined> {
  return locks ? webLock(sessionId, locks) : claimLock(sessionId, tabId);
}

function webLock(sessionId: string, locks: LockManagerLike): Promise<RunLock | undefined> {
  return new Promise((resolve, reject) => {
    locks
      .request(LOCK_PREFIX + sessionId, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(undefined);
          return;
        }
        // Holding the returned promise holds the lock.
        return new Promise<void>((release) => resolve({ release: () => release() }));
      })
      .catch(reject);
  });
}

interface Claim {
  tabId: string;
  token: string;
  at: number;
}

function readClaim(key: string): Claim | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Claim) : undefined;
  } catch {
    return undefined;
  }
}

async function claimLock(sessionId: string, tabId: string): Promise<RunLock | undefined> {
  const key = CLAIM_PREFIX + sessionId;
  const held = readClaim(key);
  if (held && held.tabId !== tabId && Date.now() - held.at < CLAIM_TTL_MS) {
    return undefined;
  }
  const token = `${tabId}:${Math.random().toString(36).slice(2)}`;
  const write = () => {
    try {
      localStorage.setItem(key, JSON.stringify({ tabId, token, at: Date.now() } satisfies Claim));
    } catch {}
  };
  write();
  await new Promise((r) => setTimeout(r, CLAIM_SETTLE_MS));
  if (readClaim(key)?.token !== token) {
    return undefined; // another tab wrote after us
  }
  const refresh = setInterval(() => {
    if (readClaim(key)?.token === token) {
      write();
    }
  }, CLAIM_TTL_MS / 3);
  return {
    release: () => {
      clearInterval(refresh);
      if (readClaim(key)?.token === token) {
        try {
          localStorage.removeItem(key);
        } catch {}
      }
    },
  };
}
