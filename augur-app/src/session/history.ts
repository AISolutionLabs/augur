// Conversation history, kept per browser (localStorage). Saved investigations live in Grafana itself.

import { AgentMode, Finding, Hypothesis, Message } from '../agent/types';
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
  savedUrl?: string;
  /** Present while an agent run is in progress or was interrupted (page reload, crash). */
  run?: { status: 'running' | 'interrupted'; mode: AgentMode; startedAt: number; interruptedAt?: number };
}

const HISTORY_KEY = `${PLUGIN_ID}/history`;
const CURRENT_KEY = `${PLUGIN_ID}/current`;
const MAX_SESSIONS = 15;
const MAX_BYTES = 3_500_000;

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

/** Saves a session (most recent first), dropping the oldest/biggest when over quota. */
export function persist(session: SessionState) {
  if (!session.items.length) {
    return;
  }
  try {
    let list = [session, ...loadHistory().filter((s) => s.id !== session.id)].slice(0, MAX_SESSIONS);
    let raw = JSON.stringify(list);
    while (raw.length > MAX_BYTES && list.length > 1) {
      list = list.slice(0, -1);
      raw = JSON.stringify(list);
    }
    if (raw.length > MAX_BYTES) {
      // A single huge session: keep the UI timeline, drop the model transcript.
      list = [{ ...session, messages: [] }];
      raw = JSON.stringify(list);
    }
    localStorage.setItem(HISTORY_KEY, raw);
    localStorage.setItem(CURRENT_KEY, session.id);
  } catch {
    // storage unavailable or full
  }
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

export function deleteSession(id: string) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(loadHistory().filter((s) => s.id !== id)));
  } catch {}
}
