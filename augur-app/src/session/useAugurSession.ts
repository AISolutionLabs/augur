import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { config } from '@grafana/runtime';

import { AgentEvent, AgentMode, Finding, Hypothesis, Usage } from '../agent/types';
import { runAgent } from '../agent/runner';
import { buildSystemPrompt, conclusionGate } from '../agent/prompts';
import { buildToolset } from '../agent/tools';
import { loadMcpCatalog, McpCatalog, mcpTools } from '../agent/tools/mcp';
import { Proposal } from '../agent/proposals';
import { saveInvestigation as saveInvestigationApi } from '../agent/investigations';
import { ClaudeDsConfig, datasourceModelCaller, getClaudeConfig, grafanaHttp, listClaudeDataSources, listDataSources } from '../api';
import { STEP_BUDGET } from '../constants';
import { AugurSettings, loadPersonalRules, loadSettings, Skill } from '../settings';
import { describeLocation } from './pageContext';
import { Item, loadCurrent, loadHistory, newSession, persist, SessionState, setCurrent, deleteSession } from './history';

export const RANGE_MS: Record<string, number> = { '15m': 9e5, '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '2d': 1728e5, '7d': 6048e5 };

export interface SessionOptions {
  variant: 'page' | 'sidebar';
  initialMode?: AgentMode;
  initialRange?: string;
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

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

export function useAugurSession(opts: SessionOptions) {
  const claudeDs = useMemo(() => listClaudeDataSources(), []);
  const [dsUid, setDsUid] = useState<string | undefined>(claudeDs.find((d) => d.isDefault)?.uid ?? claudeDs[0]?.uid);
  const [dsConfig, setDsConfig] = useState<ClaudeDsConfig | undefined>();
  const [configError, setConfigError] = useState<string | undefined>();
  const [model, setModel] = useState<string | undefined>();
  const [settings, setSettings] = useState<AugurSettings>({});
  const [mcp, setMcp] = useState<McpCatalog>({ servers: [] });
  const [session, setSession] = useState<SessionState>(() => {
    const cur = loadCurrent();
    const s = cur ?? newSession(opts.initialMode ?? 'chat', opts.initialRange ?? '1h');
    if (opts.initialMode && !cur?.items.length) {
      s.mode = opts.initialMode;
    }
    return s;
  });
  const [history, setHistory] = useState(loadHistory);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [usage, setUsage] = useState<Required<Usage>>(ZERO_USAGE);

  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // Hypotheses are read by the conclusion gate synchronously inside the agent loop, before React
  // has re-rendered, so they are mirrored in a ref that updates immediately.
  const hypothesesRef = useRef(session.hypotheses);
  const abortRef = useRef<AbortController | null>(null);
  const approvals = useRef(new Map<string, (ok: boolean) => void>());
  const pendingNotes = useRef<string[]>([]);

  useEffect(() => {
    loadSettings(grafanaHttp).then(setSettings);
  }, []);

  useEffect(() => {
    if (!dsUid) {
      return;
    }
    getClaudeConfig(dsUid)
      .then((c) => {
        setConfigError(undefined);
        setDsConfig(c);
        setModel(c.defaultModel);
        if (c.mcpServers?.length) {
          loadMcpCatalog(grafanaHttp, dsUid).then(setMcp);
        } else {
          setMcp({ servers: [] });
        }
      })
      .catch((e) => setConfigError(e?.data?.error?.message ?? e?.data?.message ?? e?.message ?? 'Could not load Claude datasource config'));
  }, [dsUid]);

  // Persist on every change (cheap; localStorage writes are synchronous but small).
  useEffect(() => {
    persist(session);
  }, [session]);

  const update = useCallback((fn: (s: SessionState) => SessionState) => {
    setSession((s) => ({ ...fn(s), updatedAt: Date.now() }));
  }, []);

  const pushItem = useCallback((item: Item) => update((s) => ({ ...s, items: [...s.items, item] })), [update]);

  const onEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.kind) {
        case 'assistant_text':
          pushItem({ kind: 'assistant', text: e.text });
          break;
        case 'tool_start':
          pushItem({ kind: 'tool', id: e.id, name: e.name, label: e.agent ? `[${e.agent}] ${e.label}` : e.label, input: e.input, status: 'running', agent: e.agent });
          break;
        case 'tool_end':
          update((s) => ({
            ...s,
            items: s.items.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, status: e.ok ? 'ok' : 'error', output: e.output, ms: e.ms } : x)),
          }));
          break;
        case 'usage':
          setUsage((u) => ({
            input_tokens: u.input_tokens + (e.usage.input_tokens ?? 0),
            output_tokens: u.output_tokens + (e.usage.output_tokens ?? 0),
            cache_read_input_tokens: u.cache_read_input_tokens + (e.usage.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: u.cache_creation_input_tokens + (e.usage.cache_creation_input_tokens ?? 0),
          }));
          break;
        case 'status':
          setStatus(e.text);
          break;
        case 'error':
          pushItem({ kind: 'error', text: e.text });
          break;
        case 'done':
          setStatus('');
          if (e.stopReason === 'max_tokens') {
            pushItem({ kind: 'notice', text: 'The response hit the output token limit. Ask Augur to continue, or raise Max output tokens on the datasource.' });
          }
          break;
      }
    },
    [pushItem, update]
  );

  const send = useCallback(
    async (textIn: string, extra?: { context?: string; mode?: AgentMode }) => {
      const text = textIn.trim();
      if (!text || running || !dsUid) {
        return;
      }
      const mode = extra?.mode ?? sessionRef.current.mode;
      const skills = settings.skills ?? [];
      const { userText: expanded, skill } = expandSlashCommand(text, skills);
      let userText = mode === 'investigate' && !skill ? `Investigate: ${expanded}` : expanded;
      if (extra?.context) {
        userText = `Context from where I opened Augur:\n${extra.context}\n\n${userText}`;
      }
      if (pendingNotes.current.length) {
        userText = `${pendingNotes.current.join('\n')}\n\n${userText}`;
        pendingNotes.current = [];
      }
      const transcript = [...sessionRef.current.messages, { role: 'user' as const, content: [{ type: 'text' as const, text: userText }] }];
      update((s) => ({
        ...s,
        mode,
        title: s.items.length ? s.title : text.slice(0, 80),
        items: [...s.items, { kind: 'user', text, mode }],
        messages: transcript,
      }));

      const ac = new AbortController();
      abortRef.current = ac;
      setRunning(true);
      const now = Date.now();
      const range = { from: now - (RANGE_MS[sessionRef.current.rangeKey] ?? 36e5), to: now };
      const datasources = listDataSources();
      const user = config.bootData?.user;
      const call = datasourceModelCaller(dsUid);
      const subAgents = mode === 'investigate' && settings.enableSubAgents !== false;
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
        pageContext: opts.variant === 'sidebar' ? describeLocation() : undefined,
        mcpServers: mcp.servers.filter((s) => s.tools?.length).map((s) => s.name),
      };
      const system = buildSystemPrompt({ ...promptBase, mode, subAgents });
      const propose = (p: Proposal) =>
        update((s) => ({ ...s, proposals: { ...s.proposals, [p.id]: p }, items: [...s.items, { kind: 'proposal', id: p.id }] }));
      const tools = buildToolset(mode, {
        propose,
        skills,
        memory: settings.memory,
        mcp: mcpTools(mcp, dsUid),
        delegate: subAgents ? { call, model, maxTokens: dsConfig?.maxTokens, baseSystem: buildSystemPrompt({ ...promptBase, mode: 'chat' }), onEvent } : undefined,
      });
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
          beforeFinish: mode === 'investigate' ? () => conclusionGate(hypothesesRef.current) : undefined,
          ctx: {
            http: grafanaHttp,
            listDataSources: () => datasources,
            timeRange: range,
            now: () => Date.now(),
            signal: ac.signal,
            propose,
            recordFinding: (f: Finding) => update((s) => ({ ...s, findings: [...s.findings, f], items: [...s.items, { kind: 'finding', finding: f }] })),
            updateHypothesis: (h: Hypothesis) => {
              hypothesesRef.current = [...hypothesesRef.current.filter((x) => x.id !== h.id), h];
              update((s) => ({ ...s, hypotheses: [...s.hypotheses.filter((x) => x.id !== h.id), h] }));
            },
            confirm: (r) =>
              new Promise<boolean>((resolve) => {
                const id = `a-${Math.random().toString(36).slice(2, 9)}`;
                approvals.current.set(id, resolve);
                pushItem({ kind: 'approval', id, title: r.title, detail: r.detail, state: 'pending' });
                ac.signal.addEventListener('abort', () => resolve(false), { once: true });
              }),
          },
        });
        update((s) => ({ ...s, messages }));
      } finally {
        setRunning(false);
        setStatus('');
        abortRef.current = null;
        update((s) => ({
          ...s,
          items: s.items.map((x) =>
            x.kind === 'tool' && x.status === 'running'
              ? { ...x, status: 'error', output: 'cancelled' }
              : x.kind === 'approval' && x.state === 'pending'
                ? { ...x, state: 'denied' }
                : x
          ),
        }));
        setHistory(loadHistory());
      }
    },
    [running, dsUid, settings, update, opts.variant, mcp, model, dsConfig, onEvent, pushItem]
  );

  const resolveApproval = useCallback(
    (id: string, ok: boolean) => {
      approvals.current.get(id)?.(ok);
      approvals.current.delete(id);
      update((s) => ({ ...s, items: s.items.map((x) => (x.kind === 'approval' && x.id === id ? { ...x, state: ok ? 'approved' : 'denied' } : x)) }));
    },
    [update]
  );

  const noteApplied = useCallback(
    (text: string, url?: string) => {
      pendingNotes.current.push(`(Note: ${text}${url ? ` — ${url}` : ''})`);
      pushItem({ kind: 'notice', text, url });
    },
    [pushItem]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    pendingNotes.current = [];
    const s = newSession(sessionRef.current.mode, sessionRef.current.rangeKey);
    hypothesesRef.current = [];
    setCurrent(undefined);
    setSession(s);
    setUsage(ZERO_USAGE);
    setHistory(loadHistory());
  }, []);

  const open = useCallback((id: string) => {
    const s = loadHistory().find((x) => x.id === id);
    if (s) {
      abortRef.current?.abort();
      hypothesesRef.current = s.hypotheses;
      setSession(s);
      setCurrent(id);
    }
  }, []);

  const remove = useCallback((id: string) => {
    deleteSession(id);
    setHistory(loadHistory());
  }, []);

  const saveInvestigation = useCallback(
    async (folderUid?: string) => {
      const s = sessionRef.current;
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
          range: { from: s.createdAt - (RANGE_MS[s.rangeKey] ?? 36e5), to: now },
          user: config.bootData?.user?.login,
        },
        listDataSources(),
        folderUid ?? settings.investigationFolderUid
      );
      update((x) => ({ ...x, savedUrl: r.url }));
      return r;
    },
    [settings.investigationFolderUid, update]
  );

  return {
    claudeDs,
    dsUid,
    setDsUid,
    dsConfig,
    configError,
    model,
    setModel,
    settings,
    setSettings,
    mcp,
    session,
    setMode: (mode: AgentMode) => update((s) => ({ ...s, mode })),
    setRangeKey: (rangeKey: string) => update((s) => ({ ...s, rangeKey })),
    history,
    running,
    status,
    usage,
    send,
    stop,
    reset,
    open,
    remove,
    resolveApproval,
    noteApplied,
    saveInvestigation,
  };
}

export type AugurSession = ReturnType<typeof useAugurSession>;
