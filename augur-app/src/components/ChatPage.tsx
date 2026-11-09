import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { config, PluginPage } from '@grafana/runtime';
import { Alert, Badge, Button, Combobox, ComboboxOption, EmptyState, Icon, RadioButtonGroup, Spinner, Stack, TextArea, useStyles2 } from '@grafana/ui';

import { AgentEvent, AgentMode, Finding, Message, Usage } from '../agent/types';
import { runAgent } from '../agent/runner';
import { buildSystemPrompt } from '../agent/prompts';
import { buildToolset } from '../agent/tools';
import { DashboardDraft } from '../agent/dashboard';
import { datasourceModelCaller, getClaudeConfig, grafanaHttp, listClaudeDataSources, listDataSources, ClaudeDsConfig } from '../api';
import { STEP_BUDGET } from '../constants';
import { buildReport, download } from '../report';
import { Markdown } from './Markdown';
import { ToolItem, ToolStep } from './ToolStep';
import { DraftCard } from './DraftCard';

type Item =
  | { kind: 'user'; text: string; mode: AgentMode }
  | { kind: 'assistant'; text: string }
  | ToolItem
  | { kind: 'finding'; finding: Finding }
  | { kind: 'draft'; draftId: string }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string };

const RANGES: Array<ComboboxOption<string>> = [
  { label: 'Last 15 minutes', value: '15m' },
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 3 hours', value: '3h' },
  { label: 'Last 6 hours', value: '6h' },
  { label: 'Last 12 hours', value: '12h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 2 days', value: '2d' },
  { label: 'Last 7 days', value: '7d' },
];
const RANGE_MS: Record<string, number> = { '15m': 9e5, '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '2d': 1728e5, '7d': 6048e5 };

const MODES: Array<SelectableValue<AgentMode>> = [
  { label: 'Chat', value: 'chat', icon: 'comment-alt', description: 'Quick questions and dashboard building' },
  { label: 'Investigate', value: 'investigate', icon: 'search', description: 'Deep root-cause analysis across all signals' },
];

const STARTERS: Record<AgentMode, string[]> = {
  chat: [
    'Which services have the highest error rate right now?',
    'What alerts are firing and what do they mean?',
    'Build a RED dashboard for the checkout service with logs and traces',
    'Which Loki streams are the noisiest in the last hour?',
  ],
  investigate: [
    'Latency for the API gateway spiked in the last hour. Find out why.',
    'Investigate the currently firing alerts and whether they share a root cause.',
    'Error logs increased after the last deployment. Was the deploy the cause?',
  ],
};

const STORAGE_KEY = 'augur-assistant-app/session';

interface Persisted {
  items: Item[];
  messages: Message[];
  drafts: Record<string, DashboardDraft>;
  findings: Finding[];
  mode: AgentMode;
  rangeKey: string;
}

function loadSession(): Persisted | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : undefined;
  } catch {
    return undefined;
  }
}

export function ChatPage() {
  const s = useStyles2(getStyles);
  const [params, setParams] = useSearchParams();
  const restored = useMemo(loadSession, []);

  const claudeDs = useMemo(listClaudeDataSources, []);
  const [dsUid, setDsUid] = useState<string | undefined>(claudeDs.find((d) => d.isDefault)?.uid ?? claudeDs[0]?.uid);
  const [dsConfig, setDsConfig] = useState<ClaudeDsConfig | undefined>();
  const [configError, setConfigError] = useState<string | undefined>();
  const [model, setModel] = useState<string | undefined>();
  const [mode, setMode] = useState<AgentMode>((params.get('mode') as AgentMode) || restored?.mode || 'chat');
  const [rangeKey, setRangeKey] = useState(params.get('range') || restored?.rangeKey || '1h');
  const [items, setItems] = useState<Item[]>(restored?.items ?? []);
  const [drafts, setDrafts] = useState<Record<string, DashboardDraft>>(restored?.drafts ?? {});
  const [findings, setFindings] = useState<Finding[]>(restored?.findings ?? []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [usage, setUsage] = useState<Required<Usage>>({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const messagesRef = useRef<Message[]>(restored?.messages ?? []);
  const pendingNotes = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastQuestion = useRef<string>('');

  useEffect(() => {
    if (!dsUid) {
      return;
    }
    getClaudeConfig(dsUid)
      .then((c) => {
        setConfigError(undefined);
        setDsConfig(c);
        setModel(c.defaultModel);
      })
      .catch((e) => setConfigError(e?.data?.error?.message ?? e?.data?.message ?? e?.message ?? 'Could not load Claude datasource config'));
  }, [dsUid]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ items, messages: messagesRef.current, drafts, findings, mode, rangeKey } satisfies Persisted));
    } catch {
      // Storage full or unavailable: the session simply won't survive navigation.
    }
  }, [items, drafts, findings, mode, rangeKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, status]);

  const onEvent = useCallback((e: AgentEvent) => {
    switch (e.kind) {
      case 'assistant_text':
        setItems((xs) => [...xs, { kind: 'assistant', text: e.text }]);
        break;
      case 'tool_start':
        setItems((xs) => [...xs, { kind: 'tool', id: e.id, name: e.name, label: e.label, input: e.input, status: 'running' }]);
        break;
      case 'tool_end':
        setItems((xs) => xs.map((x) => (x.kind === 'tool' && x.id === e.id ? { ...x, status: e.ok ? 'ok' : 'error', output: e.output, ms: e.ms } : x)));
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
        setItems((xs) => [...xs, { kind: 'error', text: e.text }]);
        break;
      case 'done':
        setStatus('');
        if (e.stopReason === 'max_tokens') {
          setItems((xs) => [...xs, { kind: 'notice', text: 'The response hit the output token limit. Ask Claude to continue, or raise Max output tokens on the datasource.' }]);
        }
        break;
    }
  }, []);

  const send = useCallback(
    async (textIn?: string) => {
      const text = (textIn ?? input).trim();
      if (!text || running || !dsUid) {
        return;
      }
      setInput('');
      lastQuestion.current = text;
      const ctxParam = params.get('context');
      let userText = mode === 'investigate' ? `Investigate: ${text}` : text;
      if (ctxParam && messagesRef.current.length === 0) {
        userText = `Context from where I opened Claude:\n${ctxParam}\n\n${userText}`;
        params.delete('context');
        setParams(params, { replace: true });
      }
      if (pendingNotes.current.length) {
        userText = `${pendingNotes.current.join('\n')}\n\n${userText}`;
        pendingNotes.current = [];
      }
      setItems((xs) => [...xs, { kind: 'user', text, mode }]);
      messagesRef.current = [...messagesRef.current, { role: 'user', content: [{ type: 'text', text: userText }] }];

      const ac = new AbortController();
      abortRef.current = ac;
      setRunning(true);
      const now = Date.now();
      const range = { from: now - (RANGE_MS[rangeKey] ?? 36e5), to: now };
      const datasources = listDataSources();
      const user = config.bootData?.user;
      const system = buildSystemPrompt({
        mode,
        now,
        range,
        datasources,
        user: { login: user?.login, orgRole: user?.orgRole },
        grafanaVersion: config.buildInfo?.version,
      });
      const tools = buildToolset(mode, (d) => {
        setDrafts((m) => ({ ...m, [d.id]: d }));
        setItems((xs) => [...xs, { kind: 'draft', draftId: d.id }]);
      });
      try {
        messagesRef.current = await runAgent({
          call: datasourceModelCaller(dsUid),
          tools,
          system,
          messages: messagesRef.current,
          model,
          maxTokens: dsConfig?.maxTokens,
          maxSteps: STEP_BUDGET[mode],
          onEvent,
          ctx: {
            http: grafanaHttp,
            listDataSources: () => datasources,
            timeRange: range,
            now: () => Date.now(),
            signal: ac.signal,
            recordFinding: (f) => {
              setFindings((fs) => [...fs, f]);
              setItems((xs) => [...xs, { kind: 'finding', finding: f }]);
            },
          },
        });
      } finally {
        setRunning(false);
        setStatus('');
        abortRef.current = null;
        setItems((xs) => xs.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'error', output: 'cancelled' } : x)));
      }
    },
    [input, running, dsUid, mode, rangeKey, model, dsConfig, onEvent, params, setParams]
  );

  // Auto-start when opened from a panel/alert link with ?q=...
  const autoStarted = useRef(false);
  useEffect(() => {
    const q = params.get('q');
    if (q && dsUid && dsConfig && !autoStarted.current) {
      autoStarted.current = true;
      params.delete('q');
      setParams(params, { replace: true });
      send(q);
    }
  }, [params, dsUid, dsConfig, send, setParams]);

  const reset = () => {
    abortRef.current?.abort();
    messagesRef.current = [];
    pendingNotes.current = [];
    setItems([]);
    setDrafts({});
    setFindings([]);
    setUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  };

  const exportReport = () => {
    const finalAnswer = [...items].reverse().find((x) => x.kind === 'assistant') as { text: string } | undefined;
    const now = Date.now();
    const md = buildReport({
      title: `Investigation: ${lastQuestion.current || 'Grafana'}`.slice(0, 120),
      question: lastQuestion.current,
      range: { from: now - (RANGE_MS[rangeKey] ?? 36e5), to: now },
      finalAnswer: finalAnswer?.text ?? '',
      findings,
      queries: items.filter((x): x is ToolItem => x.kind === 'tool').map((x) => ({ label: x.label, ok: x.status === 'ok' })),
      user: config.bootData?.user?.login,
      generatedAt: now,
    });
    download(`investigation-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`, md);
  };

  const latestDraftId = useMemo(() => [...items].reverse().find((x) => x.kind === 'draft') as { draftId: string } | undefined, [items])?.draftId;
  const toolCount = items.filter((x) => x.kind === 'tool').length;

  if (!claudeDs.length) {
    return (
      <PluginPage>
        <EmptyState variant="call-to-action" message="Connect Augur to Claude" button={<Button icon="plus" onClick={() => (window.location.href = '/connections/datasources/new')}>Add Claude datasource</Button>}>
          Add a <b>Claude (Augur)</b> datasource (Connections → Data sources) pointing at your LiteLLM proxy or the Anthropic API, using an API key or by forwarding each user&apos;s OAuth token.
        </EmptyState>
      </PluginPage>
    );
  }

  const actions = (
    <Stack gap={1} alignItems="center" wrap="wrap">
      {claudeDs.length > 1 && (
        <Combobox width={24} options={claudeDs.map((d) => ({ label: d.name, value: d.uid }))} value={dsUid} onChange={(v) => setDsUid(v.value)} aria-label="Claude datasource" />
      )}
      {dsConfig && dsConfig.models.length > 1 && (
        <Combobox width={26} options={dsConfig.models.map((m) => ({ label: m, value: m }))} value={model} onChange={(v) => setModel(v.value)} aria-label="Model" />
      )}
      <Combobox width={18} options={RANGES} value={rangeKey} onChange={(v) => setRangeKey(v.value)} aria-label="Time range" />
      {mode === 'investigate' && items.some((x) => x.kind === 'assistant') && (
        <Button variant="secondary" icon="download-alt" onClick={exportReport} disabled={running}>
          Export report
        </Button>
      )}
      <Button variant="secondary" icon="plus" onClick={reset}>
        New
      </Button>
    </Stack>
  );

  return (
    <PluginPage actions={actions}>
      <div className={cx(s.layout, mode === 'investigate' && s.withSidebar)}>
        <div className={s.main}>
          <RadioButtonGroup options={MODES} value={mode} onChange={setMode} disabled={running} />
          {configError && (
            <Alert severity="error" title="Claude datasource problem">
              {configError}
            </Alert>
          )}

          <div className={s.timeline} data-testid="claude-timeline">
            {items.length === 0 && (
              <div className={s.empty}>
                <div className={s.emptyTitle}>{mode === 'investigate' ? 'Describe the symptom to investigate' : 'Ask about your metrics, logs, traces and alerts'}</div>
                <div className={s.starters}>
                  {STARTERS[mode].map((q) => (
                    <Button key={q} variant="secondary" fill="outline" size="sm" onClick={() => send(q)} disabled={!dsConfig}>
                      {q}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {items.map((it, i) => {
              switch (it.kind) {
                case 'user':
                  return (
                    <div key={i} className={s.user}>
                      {it.mode === 'investigate' && <Badge color="purple" text="Investigation" icon="search" />}
                      <div>{it.text}</div>
                    </div>
                  );
                case 'assistant':
                  return <Markdown key={i} text={it.text} className={s.assistant} />;
                case 'tool':
                  return <ToolStep key={it.id} item={it} />;
                case 'finding':
                  return (
                    <div key={i} className={cx(s.finding, s[`sev_${it.finding.severity}`])}>
                      <Icon name="ai" /> <b>{it.finding.title}</b> — {it.finding.detail}
                    </div>
                  );
                case 'draft':
                  return drafts[it.draftId] ? (
                    <DraftCard
                      key={it.draftId}
                      draft={drafts[it.draftId]}
                      superseded={it.draftId !== latestDraftId}
                      onSaved={(title, url) => {
                        pendingNotes.current.push(`(Note: I saved the dashboard "${title}" at ${url}.)`);
                        setItems((xs) => [...xs, { kind: 'notice', text: `Saved "${title}".` }]);
                      }}
                    />
                  ) : null;
                case 'error':
                  return (
                    <Alert key={i} severity="error" title="Error">
                      {it.text}
                    </Alert>
                  );
                case 'notice':
                  return (
                    <div key={i} className={s.notice}>
                      <Icon name="info-circle" /> {it.text}
                    </div>
                  );
              }
            })}
            {running && (
              <div className={s.status}>
                <Spinner inline /> {status || 'Working…'}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className={s.composer}>
            <TextArea
              rows={3}
              value={input}
              placeholder={mode === 'investigate' ? 'e.g. p99 latency on payments doubled since 14:00 UTC. Why?' : 'Ask a question, or ask Claude to build a dashboard… (Enter to send, Shift+Enter for newline)'}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={!dsConfig}
            />
            <Stack justifyContent="space-between" alignItems="center">
              <span className={s.meta}>
                {toolCount > 0 && `${toolCount} tool calls · `}
                {usage.input_tokens + usage.cache_read_input_tokens > 0 &&
                  `${Math.round((usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens) / 1000)}k in / ${Math.round(usage.output_tokens / 1000)}k out tokens` +
                    (usage.cache_read_input_tokens ? ` (${Math.round((100 * usage.cache_read_input_tokens) / (usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens))}% cached)` : '')}
                {dsConfig && ` · ${model} via ${dsConfig.authMethod === 'oauth' ? 'your identity' : 'datasource key'}`}
              </span>
              {running ? (
                <Button variant="destructive" icon="square-shape" onClick={() => abortRef.current?.abort()}>
                  Stop
                </Button>
              ) : (
                <Button icon={mode === 'investigate' ? 'search' : 'message'} onClick={() => send()} disabled={!input.trim() || !dsConfig}>
                  {mode === 'investigate' ? 'Investigate' : 'Send'}
                </Button>
              )}
            </Stack>
          </div>
        </div>

        {mode === 'investigate' && (
          <aside className={s.sidebar}>
            <h4>Findings</h4>
            {findings.length === 0 ? (
              <p className={s.meta}>Findings will appear here as Claude confirms or rules out hypotheses.</p>
            ) : (
              findings.map((f, i) => (
                <div key={i} className={cx(s.findingCard, s[`sev_${f.severity}`])}>
                  <div className={s.findingHead}>
                    <Badge color={f.severity === 'critical' || f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'orange' : 'blue'} text={f.severity} />
                    <span>{new Date(f.at).toISOString().slice(11, 19)}Z</span>
                  </div>
                  <b>{f.title}</b>
                  <div>{f.detail}</div>
                  {f.evidence && <code className={s.evidence}>{f.evidence}</code>}
                </div>
              ))
            )}
          </aside>
        )}
      </div>
    </PluginPage>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  layout: css({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: t.spacing(2), height: '100%' }),
  withSidebar: css({ [t.breakpoints.up('lg')]: { gridTemplateColumns: 'minmax(0, 1fr) 340px' } }),
  main: css({ display: 'flex', flexDirection: 'column', gap: t.spacing(2), minHeight: 0 }),
  timeline: css({ display: 'flex', flexDirection: 'column', gap: t.spacing(1.5), flex: 1, minHeight: 300 }),
  empty: css({ margin: 'auto', textAlign: 'center', maxWidth: 720, padding: t.spacing(6, 2) }),
  emptyTitle: css({ fontSize: t.typography.h4.fontSize, marginBottom: t.spacing(2) }),
  starters: css({ display: 'flex', flexWrap: 'wrap', gap: t.spacing(1), justifyContent: 'center' }),
  user: css({
    alignSelf: 'flex-end',
    maxWidth: '80%',
    background: t.colors.primary.transparent,
    border: `1px solid ${t.colors.primary.border}`,
    borderRadius: t.shape.radius.default,
    padding: t.spacing(1, 1.5),
    whiteSpace: 'pre-wrap',
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(0.5),
  }),
  assistant: css({ maxWidth: '100%', overflowX: 'auto', 'pre, code': { whiteSpace: 'pre-wrap' } }),
  finding: css({ borderLeft: `3px solid ${t.colors.info.border}`, padding: t.spacing(0.5, 1), background: t.colors.background.secondary }),
  sev_info: css({ borderLeftColor: t.colors.info.border }),
  sev_low: css({ borderLeftColor: t.colors.info.border }),
  sev_medium: css({ borderLeftColor: t.colors.warning.border }),
  sev_high: css({ borderLeftColor: t.colors.error.border }),
  sev_critical: css({ borderLeftColor: t.colors.error.main }),
  notice: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize }),
  status: css({ color: t.colors.text.secondary, display: 'flex', gap: t.spacing(1), alignItems: 'center' }),
  composer: css({
    position: 'sticky',
    bottom: 0,
    background: t.colors.background.primary,
    paddingTop: t.spacing(1),
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(1),
  }),
  meta: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize }),
  sidebar: css({
    borderLeft: `1px solid ${t.colors.border.weak}`,
    paddingLeft: t.spacing(2),
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(1),
    overflowY: 'auto',
    maxHeight: 'calc(100vh - 160px)',
    position: 'sticky',
    top: 0,
  }),
  findingCard: css({
    borderLeft: `3px solid ${t.colors.info.border}`,
    background: t.colors.background.secondary,
    padding: t.spacing(1),
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(0.5),
    fontSize: t.typography.bodySmall.fontSize,
  }),
  findingHead: css({ display: 'flex', justifyContent: 'space-between', color: t.colors.text.secondary }),
  evidence: css({ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }),
});
