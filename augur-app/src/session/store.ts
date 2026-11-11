// The Augur session store lives at module scope, outside React. Grafana is a single-page app, so
// the agent keeps running while the user navigates between dashboards or closes the sidebar; the
// page and the sidebar are just two views subscribed to the same store.
//
// Every model response and every batch of tool results is checkpointed to localStorage. If the tab
// is reloaded or crashes mid-run, the session comes back marked "interrupted" and can be resumed from
// the last checkpoint.

import { config } from '@grafana/runtime';

import { AgentEvent, AgentMode, ContentBlock, EvidenceRecord, Finding, Hypothesis, Message, ToolUseBlock, Usage } from '../agent/types';
import { runAgent } from '../agent/runner';
import { buildSystemPrompt, conclusionGate, resolveTimezone, stateReminder } from '../agent/prompts';
import { buildToolset } from '../agent/tools';
import { loadMcpCatalog, McpCatalog, mcpTools } from '../agent/tools/mcp';
import { Proposal } from '../agent/proposals';
import { DashboardDraft } from '../agent/dashboard';
import { saveInvestigation as saveInvestigationApi } from '../agent/investigations';
import { ClaudeDsConfig, datasourceModelCaller, getClaudeConfig, grafanaHttp, listClaudeDataSources, listDataSources } from '../api';
import { STEP_BUDGET } from '../constants';
import { AugurSettings, DEFAULT_MAX_TOKENS_PER_RUN, effectiveTokens, loadPersonalRules, loadSettings, Skill } from '../settings';
import { Item, loadCurrent, loadHistory, newSession, patchStored, persist, SessionState, setCurrent, deleteSession } from './history';

export const RANGE_MS: Record<string, number> = { '15m': 9e5, '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '2d': 1728e5, '7d': 6048e5 };

const ZERO_USAGE: Required<Usage> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** Conversations that may run at the same time in one browser tab. */
export const MAX_PARALLEL_RUNS = 3;

/** What the conversation list shows about a run in progress. */
export interface RunSummary {
  title: string;
  mode: AgentMode;
  status: string;
  startedAt: number;
  pendingApprovals: number;
}

export interface StoreState {
  ready: boolean;
  /** Another browser tab currently holds the run lease for this session. */
  runningElsewhere: boolean;
  claudeDs: Array<{ uid: string; name: string; type: string; isDefault?: boolean }>;
  dsUid?: string;
  dsConfig?: ClaudeDsConfig;
  configError?: string;
  model?: string;
  settings: AugurSettings;
  mcp: McpCatalog;
  session: SessionState;
  history: SessionState[];
  /** The open conversation has a run in progress (in this tab). */
  running: boolean;
  status: string;
  usage: Required<Usage>;
  /** Every run in progress in this tab, by conversation id (they continue while you switch). */
  runs: Record<string, RunSummary>;
}

/** Runtime of one conversation's run. Several can be active; each is bound to its conversation. */
interface RunCtx {
  sessionId: string;
  session: SessionState;
  abort: AbortController;
  approvals: Map<string, (ok: boolean) => void>;
  hypotheses: Hypothesis[];
  status: string;
  usage: Required<Usage>;
}

/** Expands "/skill-name args" into the skill's instructions. */
export function expandSlashCommand(text: string, skills: Skill[]): { userText: string; skill?: Skill } {
  const m = text.match(/^\/([a-z0-9][a-z0-9-]*)\b\s*([\s\S]*)$/i);
  if (!m) {
    return { userText: text };
  }
  const skill = skills.find((s) => s.enabled && s.name === m[1].toLowerCase());
  if (!skill) {
    return { userText: text };
  }
  const args = m[2].trim();
  return {
    skill,
    userText: `Run the skill "${skill.title}" (/${skill.name})${args ? ` with: ${args}` : ''}.\n\nSkill instructions:\n${skill.body}`,
  };
}

/**
 * Prepares a checkpointed transcript for resumption: tool calls that never got results are closed
 * with an error result, and a note tells the model the run was interrupted.
 */
export function prepareResume(messages: Message[], interruptedAt: number): Message[] {
  const out = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));
  const note: ContentBlock = {
    type: 'text',
    text: `(The session was interrupted at ${new Date(interruptedAt).toISOString()} (page reload or browser closed) and has now been resumed. Continue the task from where you left off; re-run any tool whose result is missing if you still need it.)`,
  };
  const last = out[out.length - 1];
  if (!last) {
    return out;
  }
  if (last.role === 'assistant') {
    const pending = (Array.isArray(last.content) ? last.content : []).filter((b): b is ToolUseBlock => b.type === 'tool_use');
    out.push({
      role: 'user',
      content: [
        ...pending.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: 'Interrupted before this tool finished.', is_error: true })),
        note,
      ],
    });
    return out;
  }
  out[out.length - 1] = { ...last, content: [...(Array.isArray(last.content) ? last.content : [{ type: 'text' as const, text: String(last.content) }]), note] };
  return out;
}

/** The newest dashboard draft proposed in a conversation (what revise_draft edits). */
export function latestDashboardDraft(s: SessionState): DashboardDraft | undefined {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === 'proposal') {
      const p = s.proposals[it.id];
      if (p?.kind === 'dashboard') {
        return p.draft;
      }
    }
  }
  return undefined;
}

/** Whether a checkpointed transcript has unfinished work (i.e. resuming makes sense). */
export function canResume(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) {
    return false;
  }
  if (last.role === 'user') {
    return true;
  }
  return Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use');
}

type Listener = () => void;

// ---- run lease (one tab runs a session at a time) -------------------------------

const LEASE_PREFIX = 'augur-assistant-app/lease/';
export const leaseKey = (sessionId: string) => `${LEASE_PREFIX}${sessionId}`;
export const LEASE_HEARTBEAT_MS = 3_000;
export const LEASE_TTL_MS = 12_000;

interface Lease {
  sessionId: string;
  tabId: string;
  heartbeat: number;
}

function readLease(sessionId: string): Lease | undefined {
  try {
    const raw = localStorage.getItem(leaseKey(sessionId));
    return raw ? (JSON.parse(raw) as Lease) : undefined;
  } catch {
    return undefined;
  }
}

/** A lease held by some other tab that is still heartbeating. */
export function liveLeaseElsewhere(sessionId: string, tabId: string, now = Date.now()): boolean {
  const l = readLease(sessionId);
  return !!l && l.sessionId === sessionId && l.tabId !== tabId && now - l.heartbeat < LEASE_TTL_MS;
}

class AugurStore {
  private state: StoreState;
  private listeners = new Set<Listener>();
  /** Runs in progress, by conversation id. */
  private runs = new Map<string, RunCtx>();
  /** Which conversation each pending approval belongs to. */
  private approvalOwner = new Map<string, string>();
  /** Notes (e.g. "user applied the dashboard") to prepend to the next message, per conversation. */
  private pendingNotes = new Map<string, string[]>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initStarted = false;
  private unloadHooked = false;
  private readonly tabId = `t-${Math.random().toString(36).slice(2, 10)}`;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;

  constructor() {
    const cur = loadCurrent();
    let session = cur ?? newSession();
    let runningElsewhere = false;
    if (session.run?.status === 'running') {
      if (liveLeaseElsewhere(session.id, this.tabId)) {
        // Another tab is actively running this session: follow it instead of declaring it interrupted.
        runningElsewhere = true;
      } else {
        // The run's tab went away without finishing: it is interrupted and can be resumed here.
        session = { ...session, run: { ...session.run, status: 'interrupted', interruptedAt: session.updatedAt } };
        persist(session);
      }
    }
    this.state = {
      runningElsewhere,
      ready: false,
      claudeDs: [],
      settings: {},
      mcp: { servers: [] },
      session,
      history: loadHistory(),
      running: false,
      status: '',
      usage: session.usage ?? ZERO_USAGE,
      runs: {},
    };
    this.published = this.state;
  }

  // ---- subscription ------------------------------------------------------------

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  // React reads `published`, which only changes when listeners are notified. Internally the store
  // works on `this.state`, which can change at any time; if React's snapshot followed it, a change
  // in the middle of a time-sliced render would make React re-render the whole Grafana page
  // synchronously (useSyncExternalStore tearing protection), over and over during a run, until it
  // aborted with error #185.
  private published!: StoreState;
  getState = () => this.published;

  private set(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    if (this.runs.size > 0) {
      this.scheduleNotify();
    } else {
      // User actions and the end of a run render right away.
      this.notifyNow();
    }
  }

  /** For user actions: apply and render right away, even while runs are batching updates. */
  private setNow(patch: Partial<StoreState>) {
    this.set(patch);
    this.notifyNow();
  }

  private notifyNow() {
    this.notifyPending = false;
    this.published = this.state;
    this.listeners.forEach((l) => l());
  }

  // During a run, React is notified at most once per frame: a fast run changes the state dozens of
  // times in a few milliseconds, and each notification re-renders the page.
  private notifyPending = false;
  private scheduleNotify() {
    if (this.notifyPending) {
      return;
    }
    this.notifyPending = true;
    const flush = () => {
      if (this.notifyPending) {
        this.notifyNow();
      }
    };
    // requestAnimationFrame pauses in background tabs, so a timer backs it up.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    }
    setTimeout(flush, 50);
  }

  /** Updates the open conversation. */
  private updateSession(fn: (s: SessionState) => SessionState, immediate = false) {
    this.updateSessionById(this.state.session.id, fn, immediate);
  }

  /**
   * Updates a conversation by id: the open one, or one running in the background (its live copy
   * is kept on the run). Either way it is saved to history.
   */
  private updateSessionById(id: string, fn: (s: SessionState) => SessionState, immediate = false) {
    const run = this.runs.get(id);
    const isOpen = id === this.state.session.id;
    const base = isOpen ? this.state.session : run?.session;
    if (!base) {
      return;
    }
    const next = { ...fn(base), updatedAt: Date.now() };
    if (run) {
      run.session = next;
    }
    if (isOpen) {
      this.set({ session: next });
    }
    this.schedulePersist(next, immediate);
  }

  private schedulePersist(session: SessionState, immediate: boolean) {
    clearTimeout(this.persistTimers.get(session.id));
    const save = () => {
      this.persistTimers.delete(session.id);
      if (this.disposed) {
        return;
      }
      const latest = this.runs.get(session.id)?.session ?? (session.id === this.state.session.id ? this.state.session : session);
      persist(latest, latest.id === this.state.session.id);
    };
    if (immediate) {
      save();
      return;
    }
    this.persistTimers.set(session.id, setTimeout(save, 300));
  }

  private pushItemTo(id: string, item: Item) {
    this.updateSessionById(id, (s) => ({ ...s, items: [...s.items, item] }));
  }

  private pushItem(item: Item) {
    this.pushItemTo(this.state.session.id, item);
  }

  /** Publishes the run summaries the conversation list shows. */
  private publishRuns() {
    const runs: Record<string, RunSummary> = {};
    for (const r of this.runs.values()) {
      runs[r.sessionId] = {
        title: r.session.title,
        mode: r.session.run?.mode ?? r.session.mode,
        status: r.status,
        startedAt: r.session.run?.startedAt ?? r.session.updatedAt,
        pendingApprovals: r.session.items.filter((x) => x.kind === 'approval' && x.state === 'pending').length,
      };
    }
    this.set({ runs });
  }

  // ---- initialisation ------------------------------------------------------------

  /** Loads datasources, settings, datasource config and MCP tools once per page load. */
  init(opts: { initialMode?: AgentMode; initialRange?: string } = {}) {
    if (opts.initialMode && !this.state.session.items.length && this.state.session.mode !== opts.initialMode) {
      this.updateSession((s) => ({ ...s, mode: opts.initialMode! }));
    }
    if (opts.initialRange && !this.state.session.items.length) {
      this.updateSession((s) => ({ ...s, rangeKey: opts.initialRange! }));
    }
    if (this.initStarted) {
      return;
    }
    this.initStarted = true;
    this.hookUnload();
    this.watchOtherTab();
    const claudeDs = listClaudeDataSources();
    const dsUid = claudeDs.find((d) => d.isDefault)?.uid ?? claudeDs[0]?.uid;
    this.set({ claudeDs, dsUid, ready: true });
    loadSettings(grafanaHttp).then((settings) => this.set({ settings }));
    if (dsUid) {
      this.loadDatasource(dsUid);
    }
  }

  /** Keeps a tab that follows another tab's run in sync, and takes over if that tab dies. */
  private watchOtherTab() {
    clearInterval(this.watcher);
    if (!this.state.runningElsewhere) {
      return;
    }
    const refresh = () => {
      const id = this.state.session.id;
      const latest = loadHistory().find((x) => x.id === id);
      if (liveLeaseElsewhere(id, this.tabId)) {
        if (latest) {
          this.set({ session: latest });
        }
        return;
      }
      clearInterval(this.watcher);
      // The other tab finished (run cleared) or died (stale lease, run still marked running).
      let next = latest ?? this.state.session;
      if (next.run?.status === 'running') {
        next = { ...next, run: { ...next.run, status: 'interrupted', interruptedAt: next.updatedAt } };
        persist(next);
      }
      this.set({ session: next, runningElsewhere: false, history: loadHistory() });
    };
    this.watcher = setInterval(refresh, LEASE_HEARTBEAT_MS);
  }

  /** Takes the cross-tab lease for a conversation's run; false if another live tab holds it. */
  private acquireLease(sessionId: string): boolean {
    if (liveLeaseElsewhere(sessionId, this.tabId)) {
      return false;
    }
    this.writeLease(sessionId);
    if (!this.heartbeat) {
      // One heartbeat refreshes every lease this tab holds.
      this.heartbeat = setInterval(() => this.runs.forEach((_, id) => this.writeLease(id)), LEASE_HEARTBEAT_MS);
    }
    return true;
  }

  private writeLease(sessionId: string) {
    try {
      localStorage.setItem(leaseKey(sessionId), JSON.stringify({ sessionId, tabId: this.tabId, heartbeat: Date.now() } satisfies Lease));
    } catch {}
  }

  private releaseLease(sessionId: string) {
    if (readLease(sessionId)?.tabId === this.tabId) {
      try {
        localStorage.removeItem(leaseKey(sessionId));
      } catch {}
    }
    if (this.runs.size === 0 || (this.runs.size === 1 && this.runs.has(sessionId))) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private hookUnload() {
    if (this.unloadHooked || typeof window === 'undefined') {
      return;
    }
    this.unloadHooked = true;
    window.addEventListener('pagehide', () => this.runs.forEach((_, id) => this.releaseLease(id)));
    window.addEventListener('beforeunload', (e) => {
      if (this.runs.size > 0) {
        this.runs.forEach((r) => persist(r.session, r.sessionId === this.state.session.id));
        // Ask the browser to confirm leaving while an investigation is running.
        e.preventDefault();
        // Older browsers only show the prompt when returnValue is set.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        e.returnValue = '';
      }
    });
  }

  setDsUid = (dsUid?: string) => {
    this.set({ dsUid });
    if (dsUid) {
      this.loadDatasource(dsUid);
    }
  };

  private loadDatasource(uid: string) {
    getClaudeConfig(uid)
      .then((c) => {
        this.set({ configError: undefined, dsConfig: c, model: c.defaultModel });
        if (c.mcpServers?.length) {
          loadMcpCatalog(grafanaHttp, uid).then((mcp) => this.set({ mcp }));
        } else {
          this.set({ mcp: { servers: [] } });
        }
      })
      .catch((e) => this.set({ configError: e?.data?.error?.message ?? e?.data?.message ?? e?.message ?? 'Could not load Claude datasource config' }));
  }

  setModel = (model?: string) => this.set({ model });
  setMode = (mode: AgentMode) => (this.updateSession((s) => ({ ...s, mode })), this.notifyNow());
  setRangeKey = (rangeKey: string) => (this.updateSession((s) => ({ ...s, rangeKey })), this.notifyNow());
  setSettings = (settings: AugurSettings) => this.set({ settings });

  // ---- agent events ------------------------------------------------------------

  /** Agent events for one conversation's run; they update that conversation wherever it is. */
  private eventsFor(run: RunCtx) {
    const id = run.sessionId;
    const isOpen = () => this.state.session.id === id;
    return (e: AgentEvent) => {
      switch (e.kind) {
        case 'assistant_text':
          this.pushItemTo(id, { kind: 'assistant', text: e.text });
          break;
        case 'tool_start':
          this.pushItemTo(id, { kind: 'tool', id: e.id, name: e.name, label: e.agent ? `[${e.agent}] ${e.label}` : e.label, input: e.input, status: 'running', agent: e.agent });
          break;
        case 'tool_end':
          this.updateSessionById(id, (s) => ({
            ...s,
            items: s.items.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, status: e.ok ? 'ok' : 'error', output: e.output, ms: e.ms } : x)),
          }));
          break;
        case 'usage': {
          const u = run.usage;
          run.usage = {
            input_tokens: u.input_tokens + (e.usage.input_tokens ?? 0),
            output_tokens: u.output_tokens + (e.usage.output_tokens ?? 0),
            cache_read_input_tokens: u.cache_read_input_tokens + (e.usage.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: u.cache_creation_input_tokens + (e.usage.cache_creation_input_tokens ?? 0),
          };
          this.updateSessionById(id, (s) => ({ ...s, usage: run.usage }));
          if (isOpen()) {
            this.set({ usage: run.usage });
          }
          break;
        }
        case 'status':
          run.status = e.text;
          if (isOpen()) {
            this.set({ status: e.text });
          }
          this.publishRuns();
          break;
        case 'error':
          this.pushItemTo(id, { kind: 'error', text: e.text });
          break;
        case 'done':
          run.status = '';
          if (isOpen()) {
            this.set({ status: '' });
          }
          if (e.stopReason === 'max_tokens') {
            this.pushItemTo(id, { kind: 'notice', text: 'The response hit the output token limit. Ask Augur to continue, or raise Max output tokens on the datasource.' });
          }
          break;
      }
    };
  }

  // ---- running ------------------------------------------------------------

  send = async (textIn: string, extra?: { context?: string; mode?: AgentMode; pageContext?: string }) => {
    const text = textIn.trim();
    const { dsUid } = this.state;
    const id = this.state.session.id;
    if (!text || this.runs.has(id) || this.state.runningElsewhere || !dsUid) {
      return;
    }
    if (this.runs.size >= MAX_PARALLEL_RUNS) {
      this.pushItem({ kind: 'notice', text: `${this.runs.size} conversations are already running. Wait for one to finish or stop one, then send again.` });
      return;
    }
    const mode = extra?.mode ?? this.state.session.mode;
    const skills = this.state.settings.skills ?? [];
    const { userText: expanded, skill } = expandSlashCommand(text, skills);
    let userText = mode === 'investigate' && !skill ? `Investigate: ${expanded}` : expanded;
    if (extra?.context) {
      userText = `Context from where I opened Augur:\n${extra.context}\n\n${userText}`;
    }
    const notes = this.pendingNotes.get(id);
    if (notes?.length) {
      userText = `${notes.join('\n')}\n\n${userText}`;
      this.pendingNotes.delete(id);
    }
    const transcript: Message[] = [...this.continuationOf(this.state.session), { role: 'user', content: [{ type: 'text', text: userText }] }];
    this.updateSession(
      (s) => ({
        ...s,
        mode,
        title: s.items.length ? s.title : text.slice(0, 80),
        items: [...s.items, { kind: 'user', text, mode }],
        messages: transcript,
      }),
      true
    );
    this.notifyNow();
    await this.run(id, transcript, mode, extra?.pageContext);
  };

  /**
   * The model transcript to continue a conversation from. Conversations compacted to save storage
   * keep their visible timeline but not the transcript; they continue from the visible text.
   */
  private continuationOf(s: SessionState): Message[] {
    if (s.messages.length || !s.items.length) {
      return s.messages;
    }
    const lines = s.items
      .map((it) => (it.kind === 'user' ? `User: ${it.text}` : it.kind === 'assistant' ? `Augur: ${it.text}` : it.kind === 'finding' ? `Finding: ${it.finding.title}` : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(-12_000);
    return [
      { role: 'user', content: [{ type: 'text', text: `(Earlier in this conversation; the detailed transcript is no longer stored.)\n\n${lines}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood. I have the earlier context.' }] },
    ];
  }

  /** Continues an interrupted run from its last checkpoint. */
  resume = async (pageContext?: string) => {
    const s = this.state.session;
    if (this.runs.has(s.id) || !s.run || !this.state.dsUid) {
      return;
    }
    if (liveLeaseElsewhere(s.id, this.tabId)) {
      // Another tab picked it up first.
      this.set({ runningElsewhere: true });
      this.watchOtherTab();
      return;
    }
    if (this.runs.size >= MAX_PARALLEL_RUNS) {
      this.pushItem({ kind: 'notice', text: `${this.runs.size} conversations are already running. Wait for one to finish or stop one, then resume.` });
      return;
    }
    const transcript = prepareResume(s.messages, s.run.interruptedAt ?? s.updatedAt);
    this.pushItem({ kind: 'notice', text: 'Resumed from the last checkpoint.' });
    // Tools that were mid-flight when the page went away will never finish.
    this.updateSession((x) => ({
      ...x,
      items: x.items.map((it) => (it.kind === 'tool' && it.status === 'running' ? { ...it, status: 'error', output: 'interrupted' } : it)),
      messages: transcript,
    }));
    await this.run(s.id, transcript, s.run.mode, pageContext);
  };

  dismissInterrupted = () => {
    this.updateSession(
      (s) => ({
        ...s,
        run: undefined,
        items: s.items.map((it) => (it.kind === 'tool' && it.status === 'running' ? { ...it, status: 'error', output: 'interrupted' } : it)),
      }),
      true
    );
  };

  private async run(id: string, transcript: Message[], mode: AgentMode, pageContext?: string) {
    const { dsUid, settings, mcp, model, dsConfig } = this.state;
    const start = id === this.state.session.id ? this.state.session : undefined;
    if (!dsUid || !start) {
      return;
    }
    if (!this.acquireLease(id)) {
      this.set({ runningElsewhere: true });
      this.watchOtherTab();
      return;
    }
    const ac = new AbortController();
    const run: RunCtx = {
      sessionId: id,
      session: start,
      abort: ac,
      approvals: new Map(),
      hypotheses: start.hypotheses,
      status: '',
      usage: start.usage ?? ZERO_USAGE,
    };
    this.runs.set(id, run);
    this.setNow({ running: true, usage: run.usage });
    this.updateSessionById(id, (s) => ({ ...s, run: { status: 'running', mode, startedAt: Date.now() } }), true);
    this.publishRuns();
    const onEvent = this.eventsFor(run);

    const now = Date.now();
    const range = { from: now - (RANGE_MS[run.session.rangeKey] ?? 36e5), to: now };
    const datasources = listDataSources();
    const user = config.bootData?.user;
    const call = datasourceModelCaller(dsUid, (attempt, reason) => onEvent({ kind: 'status', text: `Gateway unavailable (${reason}); retrying (${attempt}/4)…` }));
    const subAgents = mode === 'investigate' && settings.enableSubAgents !== false;
    const skills = settings.skills ?? [];
    const promptBase = {
      now,
      range,
      datasources,
      user: { login: user?.login, orgRole: user?.orgRole },
      grafanaVersion: config.buildInfo?.version,
      rules: settings.rules,
      personalRules: loadPersonalRules(),
      skills,
      memorySummary: settings.memory?.summary,
      pageContext,
      mcpServers: mcp.servers.filter((s) => s.tools?.length).map((s) => s.name),
      timezone: resolveTimezone(user?.timezone),
    };
    const system = buildSystemPrompt({ ...promptBase, mode, subAgents });
    const propose = (p: Proposal) =>
      this.updateSessionById(id, (s) => ({ ...s, proposals: { ...s.proposals, [p.id]: p }, items: [...s.items, { kind: 'proposal', id: p.id }] }), true);
    const tools = buildToolset(mode, {
      propose,
      skills,
      memory: settings.memory,
      mcp: mcpTools(mcp, dsUid),
      delegate: subAgents ? { call, model, maxTokens: dsConfig?.maxTokens, baseSystem: buildSystemPrompt({ ...promptBase, mode: 'chat' }), onEvent } : undefined,
    });

    const startTokens = effectiveTokens(run.usage);
    const ceiling = settings.maxTokensPerRun ?? DEFAULT_MAX_TOKENS_PER_RUN;
    let completed = false;
    try {
      const messages = await runAgent({
        call,
        tools,
        system,
        messages: transcript,
        model,
        maxTokens: dsConfig?.maxTokens,
        maxSteps: (mode === 'investigate' ? settings.stepBudget?.investigate : settings.stepBudget?.chat) ?? STEP_BUDGET[mode],
        onEvent,
        // Checkpoint: the transcript is persisted after every model response and tool batch.
        onProgress: (msgs) => this.updateSessionById(id, (s) => ({ ...s, messages: [...msgs] }), true),
        beforeFinish: mode === 'investigate' ? () => conclusionGate(run.hypotheses) : undefined,
        afterTools: mode === 'investigate' ? stateReminder() : undefined,
        budgetExceeded: () => {
          const used = effectiveTokens(run.usage) - startTokens;
          return used > ceiling ? `Token budget for this run is used up (${Math.round(used / 1000)}k of ${Math.round(ceiling / 1000)}k).` : undefined;
        },
        ctx: {
          http: grafanaHttp,
          listDataSources: () => datasources,
          timeRange: range,
          now: () => Date.now(),
          signal: ac.signal,
          propose,
          latestDraft: () => latestDashboardDraft(run.session),
          recordEvidence: (e: Omit<EvidenceRecord, 'id'>) => {
            const evId = `E${(run.session.evidence?.length ?? 0) + 1}`;
            this.updateSessionById(id, (s) => ({ ...s, evidence: [...(s.evidence ?? []), { ...e, id: evId }] }));
            return evId;
          },
          recordFinding: (f: Finding) => this.updateSessionById(id, (s) => ({ ...s, findings: [...s.findings, f], items: [...s.items, { kind: 'finding', finding: f }] })),
          updateHypothesis: (h: Hypothesis) => {
            run.hypotheses = [...run.hypotheses.filter((x) => x.id !== h.id), h];
            this.updateSessionById(id, (s) => ({ ...s, hypotheses: run.hypotheses }));
          },
          confirm: (r) =>
            new Promise<boolean>((resolve) => {
              const approvalId = `a-${Math.random().toString(36).slice(2, 9)}`;
              const onAbort = () => resolve(false);
              run.approvals.set(approvalId, (ok) => {
                ac.signal.removeEventListener('abort', onAbort);
                resolve(ok);
              });
              this.approvalOwner.set(approvalId, id);
              this.pushItemTo(id, { kind: 'approval', id: approvalId, title: r.title, detail: r.detail, state: 'pending' });
              this.publishRuns();
              ac.signal.addEventListener('abort', onAbort, { once: true });
            }),
        },
      });
      completed = true;
      this.updateSessionById(id, (s) => ({ ...s, messages }));
    } finally {
      this.runs.delete(id);
      this.releaseLease(id);
      for (const approvalId of run.approvals.keys()) {
        this.approvalOwner.delete(approvalId);
      }
      const finished = (s: SessionState): SessionState => ({
        ...s,
        run: completed || ac.signal.aborted ? undefined : s.run,
        items: s.items.map((x) =>
          x.kind === 'tool' && x.status === 'running'
            ? { ...x, status: 'error', output: 'cancelled' }
            : x.kind === 'approval' && x.state === 'pending'
              ? { ...x, state: 'denied' }
              : x
        ),
      });
      if (this.disposed) {
        return;
      }
      if (id === this.state.session.id) {
        this.updateSession(finished, true);
      } else {
        persist(finished({ ...run.session, updatedAt: Date.now() }), false);
      }
      this.publishRuns();
      this.setNow({ ...(id === this.state.session.id ? { running: false, status: '' } : {}), history: loadHistory() });
    }
  }

  resolveApproval = (approvalId: string, ok: boolean) => {
    const owner = this.approvalOwner.get(approvalId) ?? this.state.session.id;
    const run = this.runs.get(owner);
    run?.approvals.get(approvalId)?.(ok);
    run?.approvals.delete(approvalId);
    this.approvalOwner.delete(approvalId);
    this.updateSessionById(owner, (s) => ({ ...s, items: s.items.map((x) => (x.kind === 'approval' && x.id === approvalId ? { ...x, state: ok ? 'approved' : 'denied' } : x)) }));
    this.publishRuns();
    this.notifyNow();
  };

  noteApplied = (text: string, url?: string) => {
    const id = this.state.session.id;
    this.pendingNotes.set(id, [...(this.pendingNotes.get(id) ?? []), `(Note: ${text}${url ? ` — ${url}` : ''})`]);
    this.pushItem({ kind: 'notice', text, url });
  };

  /** Stops the open conversation's run (others keep going). */
  stop = () => this.runs.get(this.state.session.id)?.abort.abort();

  /** Stops every run in this tab. */
  stopAll = () => this.runs.forEach((r) => r.abort.abort());

  /** Set when the store is thrown away: late saves from runs it stopped are ignored. */
  private disposed = false;

  /** Stops timers (tests and hot reload). */
  dispose() {
    this.disposed = true;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    clearInterval(this.watcher);
    this.persistTimers.forEach((t) => clearTimeout(t));
  }

  /** Starts a new conversation. Runs in other conversations keep going. */
  reset = () => {
    const s = newSession(this.state.session.mode, this.state.session.rangeKey);
    setCurrent(undefined);
    clearInterval(this.watcher);
    this.setNow({ session: s, running: false, status: '', usage: ZERO_USAGE, history: loadHistory(), runningElsewhere: false });
  };

  /** Opens a conversation. If it is running (in this tab), you see it live; nothing is stopped. */
  open = (id: string) => {
    if (id === this.state.session.id) {
      return;
    }
    const run = this.runs.get(id);
    const s = run?.session ?? loadHistory().find((x) => x.id === id);
    if (!s) {
      return;
    }
    // Save the conversation being left (it may have unsaved edits).
    if (this.state.session.items.length && !this.runs.has(this.state.session.id)) {
      persist(this.state.session, false);
    }
    let session = s;
    let elsewhere = false;
    if (!run && s.run?.status === 'running') {
      elsewhere = liveLeaseElsewhere(s.id, this.tabId);
      if (!elsewhere) {
        session = { ...s, run: { ...s.run, status: 'interrupted', interruptedAt: s.updatedAt } };
        persist(session, false);
      }
    }
    this.setNow({
      session,
      running: !!run,
      status: run?.status ?? '',
      usage: run?.usage ?? session.usage ?? ZERO_USAGE,
      runningElsewhere: elsewhere,
      history: loadHistory(),
    });
    setCurrent(id);
    this.watchOtherTab();
  };

  remove = (id: string) => {
    this.runs.get(id)?.abort.abort();
    deleteSession(id);
    if (id === this.state.session.id) {
      this.reset();
      return;
    }
    this.setNow({ history: loadHistory() });
  };

  rename = (id: string, title: string) => {
    const t = title.trim().slice(0, 120);
    if (!t) {
      return;
    }
    if (id === this.state.session.id || this.runs.has(id)) {
      this.updateSessionById(id, (s) => ({ ...s, title: t }), true);
    } else {
      patchStored(id, { title: t });
    }
    this.setNow({ history: loadHistory() });
    this.publishRuns();
  };

  togglePin = (id: string) => {
    const current = id === this.state.session.id ? this.state.session : (this.runs.get(id)?.session ?? loadHistory().find((x) => x.id === id));
    if (!current) {
      return;
    }
    if (id === this.state.session.id || this.runs.has(id)) {
      this.updateSessionById(id, (s) => ({ ...s, pinned: !s.pinned }), true);
    } else {
      patchStored(id, { pinned: !current.pinned });
    }
    this.setNow({ history: loadHistory() });
  };

  saveInvestigation = async (folderUid?: string) => {
    const s = this.state.session;
    const finalAnswer = [...s.items].reverse().find((x) => x.kind === 'assistant') as { text: string } | undefined;
    const firstQuestion = s.items.find((x) => x.kind === 'user') as { text: string } | undefined;
    const now = Date.now();
    const r = await saveInvestigationApi(
      grafanaHttp,
      {
        title: `Investigation: ${firstQuestion?.text ?? s.title}`,
        question: firstQuestion?.text ?? s.title,
        report: finalAnswer?.text ?? '',
        findings: s.findings,
        hypotheses: s.hypotheses,
        evidence: s.items.filter((x): x is Extract<Item, { kind: 'tool' }> => x.kind === 'tool').map((x) => ({ tool: x.name, input: x.input as any, ok: x.status === 'ok' })),
        ledger: s.evidence ?? [],
        range: { from: s.createdAt - (RANGE_MS[s.rangeKey] ?? 36e5), to: now },
        user: config.bootData?.user?.login,
      },
      listDataSources(),
      folderUid ?? this.state.settings.investigationFolderUid
    );
    this.updateSession((x) => ({ ...x, savedUrl: r.url }), true);
    return r;
  };
}

let store: AugurStore | undefined;

export function getStore(): AugurStore {
  if (!store) {
    store = new AugurStore();
  }
  return store;
}

/** Test helper: drops the singleton so each test starts from storage. */
export function resetStoreForTests() {
  store?.dispose();
  store?.stopAll();
  store = undefined;
}
