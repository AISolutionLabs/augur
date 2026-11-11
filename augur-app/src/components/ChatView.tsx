import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { config } from '@grafana/runtime';
import {
  Alert,
  Badge,
  Button,
  Combobox,
  ComboboxOption,
  Icon,
  IconButton,
  LinkButton,
  Modal,
  RadioButtonGroup,
  Spinner,
  Stack,
  TextArea,
  useStyles2,
} from '@grafana/ui';

import { AgentMode } from '../agent/types';
import { AugurSession, RANGE_MS } from '../session/useAugurSession';
import { Item } from '../session/history';
import { buildReport, download, printHtml, ReportInput, reportHtml } from '../report';
import { loadPersonalRules, newId, savePersonalRules } from '../settings';
import { Markdown } from './Markdown';
import { ToolStep } from './ToolStep';
import { ProposalCard } from './ProposalCards';
import { InvestigationPanel } from './InvestigationPanel';
import { Conversations } from './Conversations';

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

const MODES: Array<SelectableValue<AgentMode>> = [
  { label: 'Chat', value: 'chat', icon: 'comment-alt', description: 'Questions, queries, dashboards and alerting' },
  { label: 'Investigate', value: 'investigate', icon: 'search', description: 'Deep root-cause analysis across all signals' },
];

const STARTERS: Record<AgentMode, string[]> = {
  chat: [
    'Which services have the highest error rate right now?',
    'What alerts are firing and what do they mean?',
    'Build a RED dashboard for the checkout service with logs and traces',
    'Write an alert for 5xx ratio above 5% on the API gateway',
  ],
  investigate: [
    'Latency for the API gateway spiked in the last hour. Find out why.',
    'Investigate the currently firing alerts and whether they share a root cause.',
    'Error logs increased after the last deployment. Was the deploy the cause?',
  ],
};

const SIDEBAR_STARTERS = ['What is going on on this page?', 'Is anything unusual here in the last hour?', 'Explain this dashboard'];

export interface ChatViewProps {
  s: AugurSession;
  variant: 'page' | 'sidebar';
  autoStart?: { q: string; mode?: AgentMode; context?: string };
}

export function ChatView({ s, variant, autoStart }: ChatViewProps) {
  const st = useStyles2(getStyles);
  // The composer's text lives in <Composer>, so typing re-renders only the text box (see Composer).
  const composer = useRef<ComposerHandle>(null);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const sRef = useRef(s);
  sRef.current = s;
  const sendText = useCallback((text: string) => sRef.current.send(text), []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [showPanel, setShowPanel] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => readRailPref());
  const [listOpen, setListOpen] = useState(false);
  const toggleRail = () => {
    setRailOpen(!railOpen);
    writeRailPref(!railOpen);
  };
  const [prefs, setPrefs] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const { session } = s;
  // Runs in other conversations (the open one shows its own status).
  const runningCount = Object.keys(s.runs).filter((id) => id !== session.id).length;
  const mode = session.mode;

  // Follow the conversation only while the user is at the bottom, and jump instead of animating:
  // a smooth scroll moves Grafana's page container every frame, and Grafana's chrome re-renders on
  // each of those frames (seen as React error #185 from the breadcrumb/nav in Grafana 13).
  useEffect(() => {
    const el = bottomRef.current;
    const scroller = el ? scrollParent(el) : null;
    if (!el || !scroller) {
      return;
    }
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance < 400) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [session.items.length, s.status]);

  const started = useRef(false);
  useEffect(() => {
    if (autoStart?.q && s.dsConfig && !started.current) {
      started.current = true;
      if (session.items.length) {
        s.reset();
      }
      // Let reset land before sending.
      setTimeout(() => s.send(autoStart.q, { mode: autoStart.mode, context: autoStart.context }), 0);
    }
  }, [autoStart, s, session.items.length]);

  const skills = useMemo(() => (s.settings.skills ?? []).filter((x) => x.enabled), [s.settings.skills]);

  const latestDraft = useMemo(
    () => [...session.items].reverse().find((x) => x.kind === 'proposal' && session.proposals[x.id]?.kind === 'dashboard') as { id: string } | undefined,
    [session.items, session.proposals]
  )?.id;
  const toolCount = session.items.filter((x) => x.kind === 'tool').length;
  const hasAnswer = session.items.some((x) => x.kind === 'assistant');
  const isInvestigation = mode === 'investigate' || session.findings.length > 0 || session.hypotheses.length > 0;

  const submit = (text?: string) => {
    if (text === undefined) {
      composer.current?.submit();
      return;
    }
    if (text.trim()) {
      s.send(text);
    }
  };

  const reportInput = (): ReportInput => {
    const finalAnswer = [...session.items].reverse().find((x) => x.kind === 'assistant') as { text: string } | undefined;
    const first = session.items.find((x) => x.kind === 'user') as { text: string } | undefined;
    const now = Date.now();
    return {
      title: `Investigation: ${first?.text ?? session.title}`.slice(0, 120),
      question: first?.text ?? '',
      range: { from: session.createdAt - (RANGE_MS[session.rangeKey] ?? 36e5), to: now },
      finalAnswer: finalAnswer?.text ?? '',
      findings: session.findings,
      hypotheses: session.hypotheses,
      queries: session.items.filter((x): x is Extract<Item, { kind: 'tool' }> => x.kind === 'tool').map((x) => ({ label: x.label, ok: x.status === 'ok' })),
      ledger: session.evidence,
      user: config.bootData?.user?.login,
      generatedAt: now,
    };
  };

  const exportMarkdown = () => {
    const r = reportInput();
    download(`augur-${new Date(r.generatedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`, buildReport(r));
  };

  const exportPdf = () => printHtml(reportHtml(reportInput()));

  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const r = await s.saveInvestigation();
      s.noteApplied('Saved this investigation to Grafana', r.url);
    } catch (e: any) {
      setSaveError(e?.data?.message ?? e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toolbar = (
    <Stack gap={1} alignItems="center" wrap="wrap">
      <RadioButtonGroup size={variant === 'sidebar' ? 'sm' : 'md'} options={MODES} value={mode} onChange={s.setMode} disabled={s.running} />
      {s.claudeDs.length > 1 && (
        <Combobox width={22} options={s.claudeDs.map((d) => ({ label: d.name, value: d.uid }))} value={s.dsUid} onChange={(v) => s.setDsUid(v.value)} aria-label="Claude datasource" />
      )}
      {s.dsConfig && s.dsConfig.models.length > 1 && variant === 'page' && (
        <Combobox
          width={28}
          options={s.dsConfig.models.map((m) => ({ label: s.dsConfig?.modelNames?.[m] ?? m, value: m, description: s.dsConfig?.modelNames?.[m] ? m : undefined }))}
          value={s.model}
          onChange={(v) => s.setModel(v.value)}
          aria-label="Model"
        />
      )}
      <Combobox width={variant === 'sidebar' ? 16 : 18} options={RANGES} value={session.rangeKey} onChange={(v) => s.setRangeKey(v.value)} aria-label="Time range" />
      <IconButton
        name="history"
        tooltip={runningCount ? `Conversations (${runningCount} running)` : 'Conversations'}
        aria-label="Conversations"
        aria-expanded={variant === 'page' ? railOpen : listOpen}
        onClick={() => (variant === 'page' ? toggleRail() : setListOpen(!listOpen))}
      />
      {runningCount > 0 && <Badge color="blue" icon="sync" text={`${runningCount} running`} />}
      <IconButton name="plus" tooltip="New conversation" aria-label="New conversation" onClick={s.reset} />
      <IconButton
        name="user"
        tooltip="My preferences"
        aria-label="My preferences"
        onClick={() => {
          setPrefs(loadPersonalRules().map((r) => r.text).join('\n'));
          setPrefsOpen(true);
        }}
      />
      {variant === 'sidebar' && isInvestigation && (
        <IconButton name="list-ul" tooltip="Hypotheses & findings" aria-label="Hypotheses and findings" onClick={() => setShowPanel(!showPanel)} />
      )}
    </Stack>
  );

  return (
    <div
      className={cx(
        st.layout,
        variant === 'page' && railOpen && (isInvestigation ? st.withRailAndSidebar : st.withRail),
        variant === 'page' && !railOpen && isInvestigation && st.withSidebar,
        variant === 'sidebar' && st.compact
      )}
    >
      {variant === 'page' && railOpen && (
        <aside className={st.rail} aria-label="Conversations">
          <Conversations s={s} />
        </aside>
      )}
      <div className={cx(st.main, variant === 'sidebar' && listOpen && st.listMode)}>
        <div data-keep>{toolbar}</div>
        {variant === 'sidebar' && listOpen && (
          <div data-keep className={st.listPane}>
            <Conversations s={s} onOpened={() => setListOpen(false)} />
          </div>
        )}
        {s.configError && (
          <Alert severity="error" title="Claude datasource problem">
            {s.configError}
          </Alert>
        )}
        {s.mcp.servers
          .filter((m) => m.error || m.warning)
          .map((m) => (
            <div key={m.name} className={st.notice} data-testid="augur-mcp-notice">
              <Icon name={m.error ? 'exclamation-triangle' : 'info-circle'} /> MCP server <b>{m.name}</b>: {m.error ?? m.warning}
            </div>
          ))}
        {s.runningElsewhere && (
          <Alert severity="info" title="Running in another tab" data-testid="augur-elsewhere">
            This conversation is being worked on in another browser tab. Progress appears here as it is saved; you can continue once it finishes.
          </Alert>
        )}
        {s.interrupted && (
          <Alert
            severity="warning"
            title="This run was interrupted"
            data-testid="augur-interrupted"
          >
            <Stack gap={1} alignItems="center" wrap="wrap">
              <span>
                The page was reloaded or closed while Augur was working (started {new Date(s.interrupted.startedAt).toLocaleTimeString()}). Everything up to the last
                step is saved.
              </span>
              <Button size="sm" icon="play" onClick={() => s.resume()} disabled={!s.dsConfig}>
                Resume
              </Button>
              <Button size="sm" variant="secondary" fill="text" onClick={s.dismissInterrupted}>
                Dismiss
              </Button>
            </Stack>
          </Alert>
        )}
        {variant === 'sidebar' && showPanel && <InvestigationPanel findings={session.findings} hypotheses={session.hypotheses} />}

        <div className={st.timeline} data-testid="claude-timeline">
          {session.items.length === 0 && (
            <div className={st.empty}>
              <div className={st.emptyTitle}>{mode === 'investigate' ? 'Describe the symptom to investigate' : variant === 'sidebar' ? 'Ask about what you are looking at' : 'Ask about your metrics, logs, traces and alerts'}</div>
              <div className={st.starters}>
                {(variant === 'sidebar' && mode === 'chat' ? SIDEBAR_STARTERS : STARTERS[mode]).map((q) => (
                  <Button key={q} variant="secondary" fill="outline" size="sm" onClick={() => submit(q)} disabled={!s.dsConfig}>
                    {q}
                  </Button>
                ))}
              </div>
              {skills.length > 0 && (
                <div className={st.muted}>
                  Type <code>/</code> for skills: {skills.slice(0, 5).map((k) => `/${k.name}`).join(' ')}
                </div>
              )}
            </div>
          )}
          {session.items.map((it, i) => (
            <TimelineItem key={it.kind === 'tool' ? it.id : `${it.kind}-${i}`} it={it} s={s} latestDraft={latestDraft} />
          ))}
          {s.running && (
            <div className={st.status}>
              <Spinner inline /> {s.status || 'Working…'}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className={st.composer}>
          <Composer
            ref={composer}
            rows={variant === 'sidebar' ? 2 : 3}
            placeholder={mode === 'investigate' ? 'e.g. p99 latency on payments doubled since 14:00 UTC. Why?' : 'Ask, build a dashboard, draft an alert… / for skills (Enter to send)'}
            disabled={!s.dsConfig}
            skills={skills}
            onSend={sendText}
            onEmptyChange={setComposerEmpty}
          />
          <Stack justifyContent="space-between" alignItems="center" wrap="wrap">
            <span className={st.muted}>
              {toolCount > 0 && `${toolCount} tool calls · `}
              {s.usage.input_tokens + s.usage.cache_read_input_tokens > 0 &&
                `${Math.round((s.usage.input_tokens + s.usage.cache_read_input_tokens + s.usage.cache_creation_input_tokens) / 1000)}k in / ${Math.round(s.usage.output_tokens / 1000)}k out` +
                  (s.usage.cache_read_input_tokens
                    ? ` (${Math.round((100 * s.usage.cache_read_input_tokens) / (s.usage.input_tokens + s.usage.cache_read_input_tokens + s.usage.cache_creation_input_tokens))}% cached)`
                    : '')}
              {s.dsConfig && ` · ${s.model} via ${s.dsConfig.authMethod === 'oauth' ? 'your identity' : 'datasource key'}`}
            </span>
            <Stack gap={1}>
              {isInvestigation && hasAnswer && !s.running && (
                <>
                  {session.savedUrl ? (
                    <LinkButton size="sm" variant="secondary" icon="apps" href={session.savedUrl}>
                      Saved
                    </LinkButton>
                  ) : (
                    <Button size="sm" variant="secondary" icon="save" onClick={save} disabled={saving}>
                      {saving ? 'Saving…' : 'Save to Grafana'}
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" icon="download-alt" onClick={exportMarkdown} tooltip="Download the report as Markdown">
                    Markdown
                  </Button>
                  <Button size="sm" variant="secondary" icon="file-alt" onClick={exportPdf} tooltip="Print the report; choose Save as PDF">
                    PDF
                  </Button>
                </>
              )}
              {s.running ? (
                <Button variant="destructive" icon="square-shape" onClick={s.stop}>
                  Stop
                </Button>
              ) : (
                <Button icon={mode === 'investigate' ? 'search' : 'message'} onClick={() => submit()} disabled={composerEmpty || !s.dsConfig || s.runningElsewhere}>
                  {mode === 'investigate' ? 'Investigate' : 'Send'}
                </Button>
              )}
            </Stack>
          </Stack>
          {saveError && <Alert severity="error" title="Save failed">{saveError}</Alert>}
        </div>
      </div>
      {variant === 'page' && isInvestigation && <InvestigationPanel findings={session.findings} hypotheses={session.hypotheses} />}
      <Modal title="My preferences" isOpen={prefsOpen} onDismiss={() => setPrefsOpen(false)}>
        <p className={st.muted}>Personal rules Augur follows for you (stored in this browser), one per line. E.g. &quot;Prefer tables over prose&quot;, &quot;My team owns the payments namespace&quot;.</p>
        <TextArea rows={8} value={prefs} onChange={(e) => setPrefs(e.currentTarget.value)} />
        <Modal.ButtonRow>
          <Button variant="secondary" onClick={() => setPrefsOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              savePersonalRules(
                prefs
                  .split('\n')
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((text) => ({ id: newId(), text, scope: 'all' as const, enabled: true }))
              );
              setPrefsOpen(false);
            }}
          >
            Save
          </Button>
        </Modal.ButtonRow>
      </Modal>
    </div>
  );
}

function TimelineItem({ it, s, latestDraft }: { it: Item; s: AugurSession; latestDraft?: string }) {
  const st = useStyles2(getStyles);
  switch (it.kind) {
    case 'user':
      return (
        <div className={st.user}>
          {it.mode === 'investigate' && <Badge color="purple" text="Investigation" icon="search" />}
          <div>{it.text}</div>
        </div>
      );
    case 'assistant':
      return <Markdown text={it.text} className={st.assistant} />;
    case 'tool':
      // Findings are shown as their own highlighted rows; the tool row would duplicate them.
      return it.name === 'record_finding' && it.status === 'ok' ? null : <ToolStep item={{ ...it, kind: 'tool' }} />;
    case 'finding':
      return (
        <div className={cx(st.finding, st[`sev_${it.finding.severity}`])}>
          <Icon name="ai" /> <b>{it.finding.title}</b> — {it.finding.detail}
        </div>
      );
    case 'proposal': {
      const p = s.session.proposals[it.id];
      return p ? <ProposalCard proposal={p} superseded={p.kind === 'dashboard' && it.id !== latestDraft} onApplied={s.noteApplied} /> : null;
    }
    case 'approval':
      return (
        <div className={st.approval} data-testid="augur-approval">
          <b>{it.title}</b>
          <pre className={st.pre}>{it.detail}</pre>
          {it.state === 'pending' ? (
            <Stack gap={1}>
              <Button size="sm" icon="check" onClick={() => s.resolveApproval(it.id, true)}>
                Allow once
              </Button>
              <Button size="sm" variant="secondary" onClick={() => s.resolveApproval(it.id, false)}>
                Deny
              </Button>
            </Stack>
          ) : (
            <span className={st.muted}>{it.state === 'approved' ? 'Allowed' : 'Denied'}</span>
          )}
        </div>
      );
    case 'error':
      return (
        <Alert severity="error" title="Error">
          {it.text}
        </Alert>
      );
    case 'notice':
      return (
        <div className={st.notice}>
          <Icon name="info-circle" /> {it.text}
          {it.url && (
            <>
              {' '}
              <a href={it.url} className={st.link}>
                Open
              </a>
            </>
          )}
        </div>
      );
  }
}

const getStyles = (t: GrafanaTheme2) => ({
  layout: css({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: t.spacing(2), height: '100%' }),
  withSidebar: css({ [t.breakpoints.up('lg')]: { gridTemplateColumns: 'minmax(0, 1fr) 340px' } }),
  withRail: css({ [t.breakpoints.up('md')]: { gridTemplateColumns: '260px minmax(0, 1fr)' } }),
  withRailAndSidebar: css({
    [t.breakpoints.up('md')]: { gridTemplateColumns: '260px minmax(0, 1fr)' },
    [t.breakpoints.up('xl')]: { gridTemplateColumns: '260px minmax(0, 1fr) 340px' },
  }),
  rail: css({
    borderRight: `1px solid ${t.colors.border.weak}`,
    paddingRight: t.spacing(1.5),
    minHeight: 0,
    maxHeight: 'calc(100vh - 160px)',
    position: 'sticky',
    top: 0,
    [t.breakpoints.down('md')]: { display: 'none' },
  }),
  listMode: css({ '& > :not([data-keep])': { display: 'none' } }),
  listPane: css({ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }),
  compact: css({ padding: t.spacing(1), gap: t.spacing(1) }),
  main: css({ display: 'flex', flexDirection: 'column', gap: t.spacing(1.5), minHeight: 0 }),
  timeline: css({ display: 'flex', flexDirection: 'column', gap: t.spacing(1.5), flex: 1, minHeight: 200 }),
  empty: css({ margin: 'auto', textAlign: 'center', maxWidth: 720, padding: t.spacing(4, 1), display: 'flex', flexDirection: 'column', gap: t.spacing(2) }),
  emptyTitle: css({ fontSize: t.typography.h4.fontSize }),
  starters: css({ display: 'flex', flexWrap: 'wrap', gap: t.spacing(1), justifyContent: 'center' }),
  user: css({
    alignSelf: 'flex-end',
    maxWidth: '85%',
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
  approval: css({ border: `1px solid ${t.colors.warning.border}`, borderRadius: t.shape.radius.default, padding: t.spacing(1.5), display: 'flex', flexDirection: 'column', gap: t.spacing(1) }),
  pre: css({ fontSize: 11, maxHeight: 220, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }),
  notice: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize }),
  link: css({ color: t.colors.text.link }),
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
  slash: css({ border: `1px solid ${t.colors.border.medium}`, borderRadius: t.shape.radius.default, background: t.colors.background.secondary }),
  slashItem: css({ all: 'unset', display: 'block', width: '100%', padding: t.spacing(0.75, 1), cursor: 'pointer', '&:hover': { background: t.colors.action.hover } }),
  muted: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize }),
});

/** Nearest ancestor that scrolls vertically (Grafana's page container), or the document. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) {
      return n;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

interface ComposerHandle {
  submit: () => void;
}

interface ComposerProps {
  rows: number;
  placeholder: string;
  disabled: boolean;
  skills: Array<{ name: string; description?: string }>;
  onSend: (text: string) => void;
  onEmptyChange: (empty: boolean) => void;
}

/**
 * The chat input. Its text is local state, so a keystroke re-renders only this box. When typing
 * re-rendered the whole chat view (toolbar tooltips, pickers), every keystroke also re-rendered
 * Grafana 13's chrome, and after ~50 characters React aborted with error #185.
 */
const Composer = React.memo(
  React.forwardRef<ComposerHandle, ComposerProps>(function Composer({ rows, placeholder, disabled, skills, onSend, onEmptyChange }, ref) {
    const st = useStyles2(getStyles);
    const [text, setText] = useState('');
    const empty = !text.trim();
    useEffect(() => onEmptyChange(empty), [empty, onEmptyChange]);
    const slash = text.startsWith('/') && !text.includes(' ') ? skills.filter((k) => k.name.startsWith(text.slice(1).toLowerCase())).slice(0, 6) : [];
    const submit = useCallback(() => {
      if (text.trim()) {
        setText('');
        onSend(text);
      }
    }, [text, onSend]);
    useImperativeHandle(ref, () => ({ submit }), [submit]);
    return (
      <>
        {slash.length > 0 && (
          <div className={st.slash} role="listbox" aria-label="Skills">
            {slash.map((k) => (
              <button key={k.name} type="button" className={st.slashItem} onClick={() => setText(`/${k.name} `)}>
                <b>/{k.name}</b> <span className={st.muted}>{k.description}</span>
              </button>
            ))}
          </div>
        )}
        <TextArea
          aria-label="Message Augur"
          rows={rows}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Tab' && slash.length) {
              e.preventDefault();
              setText(`/${slash[0].name} `);
            }
          }}
          disabled={disabled}
        />
      </>
    );
  })
);

const RAIL_KEY = 'augur-assistant-app/conversations-rail';
function readRailPref(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== 'closed';
  } catch {
    return true;
  }
}
function writeRailPref(open: boolean) {
  try {
    localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed');
  } catch {}
}
