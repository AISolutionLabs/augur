// Conversation history, kept per browser (localStorage). Saved investigations live in Grafana itself.

import { AgentMode, EvidenceRecord, Finding, Hypothesis, Message } from '../agent/types';
import { Proposal } from '../agent/proposals';
import { PLUGIN_ID } from '../constants';

export type Item =
  | { kind: 'user'; text: string; mode: AgentMode }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; label: string; input: Record<string, unknown>; status: 'running' | 'ok' | 'error'; output?: string; ms?: number; agent?: string }
  | { kind: 'finding'; finding: Finding }
  | { kind: 'proposal'; id: string }
  | { kind: 'approval'; id: string; title: string; detail: string; state: 'pending' | 'approved' | 'denied' }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string; url?: string };

export interface SessionState {
  id: string;
  title: string;
  mode: AgentMode;
  rangeKey: string;
  createdAt: number;
  updatedAt: number;
  items: Item[];
  messages: Message[];
  proposals: Record<string, Proposal>;
  findings: Finding[];
  hypotheses: Hypothesis[];
  /** Ledger of every data query executed (reproducible: datasource, query, absolute range, digest). */
  evidence?: EvidenceRecord[];
  savedUrl?: string;
  /** Kept at the top of the list and never evicted to make room. */
  pinned?: boolean;
  /** Token usage of this conversation (all runs). */
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  /** The latest investigation in this conversation: what was asked, when, and over which window. */
  investigation?: InvestigationMeta;
  /** Present while an agent run is in progress or was interrupted (page reload, crash). */
  run?: { status: 'running' | 'interrupted'; mode: AgentMode; startedAt: number; interruptedAt?: number };
}

export interface InvestigationMeta {
  question: string;
  startedAt: number;
  completedAt?: number;
  /** The absolute window the agent was given (epoch ms). */
  range: { from: number; to: number };
}

const HISTORY_KEY = `${PLUGIN_ID}/history`;
const CURRENT_KEY = `${PLUGIN_ID}/current`;
/** Ids of deleted conversations: nothing may write them back (late saves, other tabs). */
const DELETED_KEY = `${PLUGIN_ID}/deleted`;
const MAX_TOMBSTONES = 500;
export const MAX_SESSIONS = 60;
const MAX_BYTES = 3_500_000;
/** Tool outputs of conversations that had to be compacted are cut to this many characters. */
const COMPACT_OUTPUT_CHARS = 1_500;

export function newSession(mode: AgentMode = 'chat', rangeKey = '1h'): SessionState {
  const now = Date.now();
  return {
    id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: 'New conversation',
    mode,
    rangeKey,
    createdAt: now,
    updatedAt: now,
    items: [],
    messages: [],
    proposals: {},
    findings: [],
    hypotheses: [],
  };
}

export function loadHistory(): SessionState[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function loadCurrent(): SessionState | undefined {
  try {
    const id = localStorage.getItem(CURRENT_KEY);
    return loadHistory().find((s) => s.id === id);
  } catch {
    return undefined;
  }
}

/**
 * Fits a history list into the storage budget without losing conversations if it can help it:
 * oldest unpinned conversations first lose their model transcript (they stay readable; continuing
 * them starts from their visible text), then their long tool outputs, and only then are they dropped.
 */
export function compactHistory(list: SessionState[], maxBytes = MAX_BYTES, keepId?: string): SessionState[] {
  let out = [...list];
  const size = () => JSON.stringify(out).length;
  if (size() <= maxBytes) {
    return out;
  }
  const evictable = () =>
    out
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !s.pinned && s.id !== keepId)
      .reverse(); // oldest first
  for (const { i } of evictable()) {
    if (out[i].messages.length) {
      out[i] = { ...out[i], messages: [] };
      if (size() <= maxBytes) {
        return out;
      }
    }
  }
  for (const { i } of evictable()) {
    out[i] = {
      ...out[i],
      items: out[i].items.map((it) => (it.kind === 'tool' && (it.output?.length ?? 0) > COMPACT_OUTPUT_CHARS ? { ...it, output: `${it.output!.slice(0, COMPACT_OUTPUT_CHARS)}… (trimmed to save space)` } : it)),
    };
    if (size() <= maxBytes) {
      return out;
    }
  }
  while (size() > maxBytes) {
    const victim = evictable()[0];
    if (!victim) {
      break;
    }
    out = out.filter((_, i) => i !== victim.i);
  }
  if (size() > maxBytes) {
    // A single huge conversation: keep its timeline, drop the model transcript.
    out = out.map((x) => ({ ...x, messages: [] }));
  }
  return out;
}

/**
 * Saves a session (most recent first). `makeCurrent` marks it as the one to reopen; background
 * conversations are saved without changing which one the user is looking at.
 */
export function persist(session: SessionState, makeCurrent = true) {
  if (!session.items.length || isDeleted(session.id)) {
    return;
  }
  try {
    const others = pruneExpired(loadHistory().filter((s) => s.id !== session.id));
    const pinned = others.filter((s) => s.pinned);
    const rest = others.filter((s) => !s.pinned);
    let list = [session, ...pinned, ...rest];
    // Over the count limit, the oldest unpinned conversations go first.
    while (list.length > MAX_SESSIONS) {
      const idx = list.map((s) => !s.pinned && s.id !== session.id).lastIndexOf(true);
      if (idx < 0) {
        break;
      }
      list = list.filter((_, i) => i !== idx);
    }
    list = compactHistory(list, MAX_BYTES, session.id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(sortHistory(list)));
    if (makeCurrent) {
      localStorage.setItem(CURRENT_KEY, session.id);
    }
  } catch {
    // storage unavailable or full
  }
}

/** Pinned first, then most recently updated. */
export function sortHistory(list: SessionState[]): SessionState[] {
  return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
}

/** Updates a stored conversation in place (rename, pin) without touching others. */
export function patchStored(id: string, patch: Partial<Pick<SessionState, 'title' | 'pinned'>>) {
  try {
    const list = loadHistory().map((s) => (s.id === id ? { ...s, ...patch } : s));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(sortHistory(list)));
  } catch {}
}

export function setCurrent(id: string | undefined) {
  try {
    if (id) {
      localStorage.setItem(CURRENT_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_KEY);
    }
  } catch {}
}

function tombstones(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** True once a conversation has been deleted (in any tab). */
export function isDeleted(id: string): boolean {
  return tombstones().includes(id);
}

/**
 * Deletes a conversation for good: it is removed from history and tombstoned, so a run that is
 * still unwinding, a pending debounced save or another tab cannot write it back.
 */
export function deleteSession(id: string) {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify([id, ...tombstones().filter((x) => x !== id)].slice(0, MAX_TOMBSTONES)));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(loadHistory().filter((s) => s.id !== id)));
    if (localStorage.getItem(CURRENT_KEY) === id) {
      localStorage.removeItem(CURRENT_KEY);
    }
  } catch {}
}

let retentionMs = 0;

/** Conversations not updated for this many days are deleted (0 keeps them until the count limit). */
export function setHistoryRetentionDays(days: number | undefined) {
  retentionMs = days && days > 0 ? days * 86_400_000 : 0;
  if (retentionMs) {
    try {
      const list = loadHistory();
      const kept = pruneExpired(list);
      if (kept.length !== list.length) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
      }
    } catch {}
  }
}

/** Drops conversations past the retention period. Pinned ones and live runs are kept. */
function pruneExpired(list: SessionState[], now = Date.now()): SessionState[] {
  if (!retentionMs) {
    return list;
  }
  return list.filter((s) => s.pinned || s.run?.status === 'running' || now - s.updatedAt <= retentionMs);
}
