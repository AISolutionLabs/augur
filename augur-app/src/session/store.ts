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
import { saveInvestigation as saveInvestigationApi } from '../agent/investigations';
import { ClaudeDsConfig, datasourceModelCaller, getClaudeConfig, grafanaHttp, listClaudeDataSources, listDataSources } from '../api';
import { STEP_BUDGET } from '../constants';
import { AugurSettings, DEFAULT_MAX_TOKENS_PER_RUN, effectiveTokens, loadPersonalRules, loadSettings, Skill } from '../settings';
import { Item, loadCurrent, loadHistory, newSession, persist, SessionState, setCurrent, deleteSession } from './history';

export const RANGE_MS: Record<string, number> = { '15m': 9e5, '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '2d': 1728e5, '7d': 6048e5 };

const ZERO_USAGE: Required<Usage> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

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
  running: boolean;
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

const LEASE_KEY = 'augur-assistant-app/lease';
export const LEASE_HEARTBEAT_MS = 3_000;
export const LEASE_TTL_MS = 12_000;

interface Lease {
  sessionId: string;
  tabId: string;
  heartbeat: number;
}

function readLease(): Lease | undefined {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    return raw ? (JSON.parse(raw) as Lease) : undefined;
  } catch {
    return undefined;
  }
}

/** A lease held by some other tab that is still heartbeating. */
export function liveLeaseElsewhere(sessionId: string, tabId: string, now = Date.now()): boolean {
  const l = readLease();
  return !!l && l.sessionId === sessionId && l.tabId !== tabId && now - l.heartbeat < LEASE_TTL_MS;
}

class AugurStore {
  private state: StoreState;
  private listeners = new Set<Listener>();
  private abort: AbortController | null = null;
  private approvals = new Map<string, (ok: boolean) => void>();
  private pendingNotes: string[] = [];
  private hypotheses: Hypothesis[] = [];
  private initStarted = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.hypotheses = session.hypotheses;
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
      usage: ZERO_USAGE,
    };
  }

  // ---- subscription ------------------------------------------------------------

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = () => this.state;

  private set(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private updateSession(fn: (s: SessionState) => SessionState, immediate = false) {
    const session = { ...fn(this.state.session), updatedAt: Date.now() };
    this.set({ session });
    this.schedulePersist(immediate);
  }

  private schedulePersist(immediate: boolean) {
    clearTimeout(this.persistTimer);
    if (immediate) {
      persist(this.state.session);
      return;
    }
    this.persistTimer = setTimeout(() => persist(this.state.session), 300);
  }

  private pushItem(item: Item) {
    this.updateSession((s) => ({ ...s, items: [...s.items, item] }));
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
          this.hypotheses = latest.hypotheses;
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
      this.hypotheses = next.hypotheses;
      this.set({ session: next, runningElsewhere: false, history: loadHistory() });
    };
    this.watcher = setInterval(refresh, LEASE_HEARTBEAT_MS);
  }

  private acquireLease(): boolean {
    const id = this.state.session.id;
    if (liveLeaseElsewhere(id, this.tabId)) {
      return false;
    }
    const write = () => {
      try {
        localStorage.setItem(LEASE_KEY, JSON.stringify({ sessionId: id, tabId: this.tabId, heartbeat: Date.now() } satisfies Lease));
      } catch {}
    };
    write();
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(write, LEASE_HEARTBEAT_MS);
    return true;
  }

  private releaseLease() {
    clearInterval(this.heartbeat);
    const l = readLease();
    if (l?.tabId === this.tabId) {
      try {
        localStorage.removeItem(LEASE_KEY);
      } catch {}
    }
  }

  private hookUnload() {
    if (this.unloadHooked || typeof window === 'undefined') {
      return;
    }
    this.unloadHooked = true;
    window.addEventListener('pagehide', () => this.releaseLease());
    window.addEventListener('beforeunload', (e) => {
      if (this.state.running) {
        persist(this.state.session);
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
  setMode = (mode: AgentMode) => this.updateSession((s) => ({ ...s, mode }));
  setRangeKey = (rangeKey: string) => this.updateSession((s) => ({ ...s, rangeKey }));
  setSettings = (settings: AugurSettings) => this.set({ settings });

  // ---- agent events ------------------------------------------------------------

  private onEvent = (e: AgentEvent) => {
    switch (e.kind) {
      case 'assistant_text':
        this.pushItem({ kind: 'assistant', text: e.text });
        break;
      case 'tool_start':
        this.pushItem({ kind: 'tool', id: e.id, name: e.name, label: e.agent ? `[${e.agent}] ${e.label}` : e.label, input: e.input, status: 'running', agent: e.agent });
        break;
      case 'tool_end':
        this.updateSession((s) => ({
          ...s,
          items: s.items.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, status: e.ok ? 'ok' : 'error', output: e.output, ms: e.ms } : x)),
        }));
        break;
      case 'usage': {
        const u = this.state.usage;
        this.set({
          usage: {
            input_tokens: u.input_tokens + (e.usage.input_tokens ?? 0),
            output_tokens: u.output_tokens + (e.usage.output_tokens ?? 0),
            cache_read_input_tokens: u.cache_read_input_tokens + (e.usage.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: u.cache_creation_input_tokens + (e.usage.cache_creation_input_tokens ?? 0),
          },
        });
        break;
      }
      case 'status':
        this.set({ status: e.text });
        break;
      case 'error':
        this.pushItem({ kind: 'error', text: e.text });
        break;
      case 'done':
        this.set({ status: '' });
        if (e.stopReason === 'max_tokens') {
          this.pushItem({ kind: 'notice', text: 'The response hit the output token limit. Ask Augur to continue, or raise Max output tokens on the datasource.' });
        }
        break;
    }
  };

  // ---- running ------------------------------------------------------------

  send = async (textIn: string, extra?: { context?: string; mode?: AgentMode; pageContext?: string }) => {
    const text = textIn.trim();
    const { dsUid } = this.state;
    if (!text || this.state.running || this.state.runningElsewhere || !dsUid) {
      return;
    }
    const mode = extra?.mode ?? this.state.session.mode;
    const skills = this.state.settings.skills ?? [];
    const { userText: expanded, skill } = expandSlashCommand(text, skills);
    let userText = mode === 'investigate' && !skill ? `Investigate: ${expanded}` : expanded;
    if (extra?.context) {
      userText = `Context from where I opened Augur:\n${extra.context}\n\n${userText}`;
    }
    if (this.pendingNotes.length) {
      userText = `${this.pendingNotes.join('\n')}\n\n${userText}`;
      this.pendingNotes = [];
    }
    const transcript: Message[] = [...this.state.session.messages, { role: 'user', content: [{ type: 'text', text: userText }] }];
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
    await this.run(transcript, mode, extra?.pageContext);
  };

  /** Continues an interrupted run from its last checkpoint. */
  resume = async (pageContext?: string) => {
    const s = this.state.session;
    if (this.state.running || !s.run || !this.state.dsUid) {
      return;
    }
    if (liveLeaseElsewhere(s.id, this.tabId)) {
      // Another tab picked it up first.
      this.set({ runningElsewhere: true });
      this.watchOtherTab();
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
    await this.run(transcript, s.run.mode, pageContext);
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

  private async run(transcript: Message[], mode: AgentMode, pageContext?: string) {
    const { dsUid, settings, mcp, model, dsConfig } = this.state;
    if (!dsUid) {
      return;
    }
    if (!this.acquireLease()) {
      this.set({ runningElsewhere: true });
      this.watchOtherTab();
      return;
    }
    const ac = new AbortController();
    this.abort = ac;
    this.set({ running: true });
    this.updateSession((s) => ({ ...s, run: { status: 'running', mode, startedAt: Date.now() } }), true);

    const now = Date.now();
    const range = { from: now - (RANGE_MS[this.state.session.rangeKey] ?? 36e5), to: now };
    const datasources = listDataSources();
    const user = config.bootData?.user;
    const call = datasourceModelCaller(dsUid, (attempt, reason) => this.set({ status: `Gateway unavailable (${reason}); retrying (${attempt}/4)…` }));
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
      this.updateSession((s) => ({ ...s, proposals: { ...s.proposals, [p.id]: p }, items: [...s.items, { kind: 'proposal', id: p.id }] }), true);
    const tools = buildToolset(mode, {
      propose,
      skills,
      memory: settings.memory,
      mcp: mcpTools(mcp, dsUid),
      delegate: subAgents ? { call, model, maxTokens: dsConfig?.maxTokens, baseSystem: buildSystemPrompt({ ...promptBase, mode: 'chat' }), onEvent: this.onEvent } : undefined,
    });

    const startTokens = effectiveTokens(this.state.usage);
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
        onEvent: this.onEvent,
        // Checkpoint: the transcript is persisted after every model response and tool batch.
        onProgress: (msgs) => this.updateSession((s) => ({ ...s, messages: [...msgs] }), true),
        beforeFinish: mode === 'investigate' ? () => conclusionGate(this.hypotheses) : undefined,
        afterTools: mode === 'investigate' ? stateReminder() : undefined,
        budgetExceeded: () => {
          const used = effectiveTokens(this.state.usage) - startTokens;
          return used > ceiling ? `Token budget for this run is used up (${Math.round(used / 1000)}k of ${Math.round(ceiling / 1000)}k).` : undefined;
        },
        ctx: {
          http: grafanaHttp,
          listDataSources: () => datasources,
          timeRange: range,
          now: () => Date.now(),
          signal: ac.signal,
          propose,
          recordEvidence: (e: Omit<EvidenceRecord, 'id'>) => {
            const id = `E${(this.state.session.evidence?.length ?? 0) + 1}`;
            this.updateSession((s) => ({ ...s, evidence: [...(s.evidence ?? []), { ...e, id }] }));
            return id;
          },
          recordFinding: (f: Finding) => this.updateSession((s) => ({ ...s, findings: [...s.findings, f], items: [...s.items, { kind: 'finding', finding: f }] })),
          updateHypothesis: (h: Hypothesis) => {
            this.hypotheses = [...this.hypotheses.filter((x) => x.id !== h.id), h];
            this.updateSession((s) => ({ ...s, hypotheses: this.hypotheses }));
          },
          confirm: (r) =>
            new Promise<boolean>((resolve) => {
              const id = `a-${Math.random().toString(36).slice(2, 9)}`;
              const onAbort = () => resolve(false);
              this.approvals.set(id, (ok) => {
                ac.signal.removeEventListener('abort', onAbort);
                resolve(ok);
              });
              this.pushItem({ kind: 'approval', id, title: r.title, detail: r.detail, state: 'pending' });
              ac.signal.addEventListener('abort', onAbort, { once: true });
            }),
        },
      });
      completed = true;
      this.updateSession((s) => ({ ...s, messages }));
    } finally {
      this.abort = null;
      this.releaseLease();
      this.set({ running: false, status: '' });
      this.updateSession(
        (s) => ({
          ...s,
          run: completed || ac.signal.aborted ? undefined : s.run,
          items: s.items.map((x) =>
            x.kind === 'tool' && x.status === 'running'
              ? { ...x, status: 'error', output: 'cancelled' }
              : x.kind === 'approval' && x.state === 'pending'
                ? { ...x, state: 'denied' }
                : x
          ),
        }),
        true
      );
      this.set({ history: loadHistory() });
    }
  }

  resolveApproval = (id: string, ok: boolean) => {
    this.approvals.get(id)?.(ok);
    this.approvals.delete(id);
    this.updateSession((s) => ({ ...s, items: s.items.map((x) => (x.kind === 'approval' && x.id === id ? { ...x, state: ok ? 'approved' : 'denied' } : x)) }));
  };

  noteApplied = (text: string, url?: string) => {
    this.pendingNotes.push(`(Note: ${text}${url ? ` — ${url}` : ''})`);
    this.pushItem({ kind: 'notice', text, url });
  };

  stop = () => this.abort?.abort();

  /** Stops timers (tests and hot reload). */
  dispose() {
    clearInterval(this.heartbeat);
    clearInterval(this.watcher);
  }

  reset = () => {
    this.abort?.abort();
    this.pendingNotes = [];
    this.hypotheses = [];
    const s = newSession(this.state.session.mode, this.state.session.rangeKey);
    setCurrent(undefined);
    clearInterval(this.watcher);
    this.set({ session: s, usage: ZERO_USAGE, history: loadHistory(), runningElsewhere: false });
  };

  open = (id: string) => {
    const s = loadHistory().find((x) => x.id === id);
    if (s) {
      this.abort?.abort();
      this.hypotheses = s.hypotheses;
      const elsewhere = s.run?.status === 'running' && liveLeaseElsewhere(s.id, this.tabId);
      this.set({ session: s, runningElsewhere: elsewhere });
      setCurrent(id);
      this.watchOtherTab();
    }
  };

  remove = (id: string) => {
    deleteSession(id);
    this.set({ history: loadHistory() });
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
  store?.stop();
  store?.dispose();
  store = undefined;
}
