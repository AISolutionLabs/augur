import React, { useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Badge, Button, Icon, IconButton, Input, Spinner, useStyles2 } from '@grafana/ui';

import { AugurSession, MAX_PARALLEL_RUNS } from '../session/useAugurSession';
import { SessionState } from '../session/history';

interface Row {
  id: string;
  title: string;
  mode: SessionState['mode'];
  updatedAt: number;
  pinned?: boolean;
  running: boolean;
  status?: string;
  pendingApprovals: number;
  interrupted: boolean;
  findings: number;
}

const DAY = 864e5;

/** Current time, refreshed periodically (relative times and day groups stay right). */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function group(r: Row, now: number): string {
  if (r.running) {
    return 'Running';
  }
  if (r.pinned) {
    return 'Pinned';
  }
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (r.updatedAt >= startOfToday) {
    return 'Today';
  }
  if (r.updatedAt >= startOfToday - DAY) {
    return 'Yesterday';
  }
  if (r.updatedAt >= startOfToday - 6 * DAY) {
    return 'Previous 7 days';
  }
  return 'Older';
}

const GROUPS = ['Running', 'Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'];

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.round(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)}h ago`;
  }
  return new Date(ts).toLocaleDateString();
}

/**
 * Conversation list: every chat and investigation in this browser, newest first, with the ones
 * running in the background at the top. Switching never stops a run.
 */
export function Conversations({ s, onOpened }: { s: AugurSession; onOpened?: () => void }) {
  const st = useStyles2(getStyles);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>();
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const now = useNow(30_000);

  const rows = useMemo(() => {
    const byId = new Map<string, Row>();
    const add = (x: SessionState) => {
      if (!x.items.length) {
        return;
      }
      byId.set(x.id, {
        id: x.id,
        title: x.title,
        mode: x.mode,
        updatedAt: x.updatedAt,
        pinned: x.pinned,
        running: false,
        pendingApprovals: 0,
        interrupted: x.run?.status === 'interrupted' || x.run?.status === 'running',
        findings: x.findings.length,
      });
    };
    s.history.forEach(add);
    add(s.session); // the open one may be newer than what is stored
    for (const [id, r] of Object.entries(s.runs)) {
      const row = byId.get(id);
      byId.set(id, {
        ...(row ?? { id, mode: r.mode, updatedAt: r.startedAt, pendingApprovals: 0, findings: 0, interrupted: false }),
        title: r.title,
        running: true,
        interrupted: false,
        status: r.status,
        pendingApprovals: r.pendingApprovals,
      } as Row);
    }
    const q = query.trim().toLowerCase();
    return [...byId.values()].filter((r) => !q || r.title.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [s.history, s.session, s.runs, query]);

  const grouped = GROUPS.map((g) => ({ g, rows: rows.filter((r) => group(r, now) === g) })).filter((x) => x.rows.length);
  const runningCount = Object.keys(s.runs).length;

  const open = (id: string) => {
    s.open(id);
    onOpened?.();
  };

  return (
    <div className={st.wrap} data-testid="augur-conversations">
      <div className={st.header}>
        <Button
          size="sm"
          icon="plus"
          variant="secondary"
          fill="outline"
          onClick={() => {
            s.reset();
            onOpened?.();
          }}
        >
          New
        </Button>
        <Input
          prefix={<Icon name="search" />}
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search conversations"
        />
      </div>
      {runningCount > 0 && (
        <div className={st.hint}>
          {runningCount} running{runningCount >= MAX_PARALLEL_RUNS ? ` (limit ${MAX_PARALLEL_RUNS})` : ''}; they keep going while you switch.
        </div>
      )}
      <div className={st.list} role="list">
        {grouped.length === 0 && <div className={st.hint}>{query ? 'No matching conversations.' : 'No conversations yet.'}</div>}
        {grouped.map(({ g, rows }) => (
          <div key={g}>
            <div className={st.group}>{g}</div>
            {rows.map((r) => {
              const active = r.id === s.session.id;
              if (renaming?.id === r.id) {
                return (
                  <form
                    key={r.id}
                    className={st.rename}
                    onSubmit={(e) => {
                      e.preventDefault();
                      s.rename(r.id, renaming.title);
                      setRenaming(undefined);
                    }}
                  >
                    <Input autoFocus value={renaming.title} onChange={(e) => setRenaming({ id: r.id, title: e.currentTarget.value })} aria-label="Conversation name" />
                    <IconButton name="check" type="submit" aria-label="Save name" tooltip="Save name" />
                    <IconButton name="times" aria-label="Cancel rename" tooltip="Cancel rename" onClick={() => setRenaming(undefined)} />
                  </form>
                );
              }
              return (
                <div key={r.id} role="listitem" className={cx(st.row, active && st.active)} data-testid="augur-conversation">
                  <button type="button" className={st.open} onClick={() => open(r.id)} aria-current={active ? 'true' : undefined} title={r.title}>
                    <span className={st.icon}>
                      {r.running ? <Spinner inline size="sm" /> : <Icon name={r.mode === 'investigate' ? 'search' : 'comment-alt'} size="sm" />}
                    </span>
                    <span className={st.text}>
                      <span className={st.title}>{r.title}</span>
                      <span className={st.meta}>
                        {r.running ? (r.status || 'Working…') : ago(r.updatedAt, now)}
                        {r.findings > 0 && !r.running && ` · ${r.findings} finding${r.findings === 1 ? '' : 's'}`}
                      </span>
                    </span>
                    {r.pendingApprovals > 0 && <Badge color="orange" text="Needs approval" />}
                    {r.interrupted && !r.running && <Badge color="purple" text="Interrupted" />}
                  </button>
                  {confirmDelete === r.id ? (
                    <span className={st.actions}>
                      <Button size="sm" variant="destructive" onClick={() => (s.remove(r.id), setConfirmDelete(undefined))}>
                        {r.running ? 'Stop and delete' : 'Delete'}
                      </Button>
                      <IconButton name="times" aria-label="Keep conversation" tooltip="Keep conversation" onClick={() => setConfirmDelete(undefined)} />
                    </span>
                  ) : (
                    <span className={cx(st.actions, st.hover)} data-actions>
                      <IconButton name={r.pinned ? 'favorite' : 'star'} aria-label={r.pinned ? 'Unpin' : 'Pin'} tooltip={r.pinned ? 'Unpin' : 'Pin'} onClick={() => s.togglePin(r.id)} />
                      <IconButton name="pen" aria-label="Rename" tooltip="Rename" onClick={() => setRenaming({ id: r.id, title: r.title })} />
                      <IconButton name="trash-alt" aria-label="Delete" tooltip="Delete" onClick={() => setConfirmDelete(r.id)} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={st.footer}>Stored in this browser. Save an investigation to keep it in Grafana.</div>
    </div>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  wrap: css({ display: 'flex', flexDirection: 'column', gap: t.spacing(1), minHeight: 0, height: '100%' }),
  header: css({ display: 'flex', gap: t.spacing(1), alignItems: 'center' }),
  hint: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize, padding: t.spacing(0, 0.5) }),
  list: css({ overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: t.spacing(1) }),
  group: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize, fontWeight: t.typography.fontWeightMedium, padding: t.spacing(0.5, 0.5, 0.25) }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    borderRadius: t.shape.radius.default,
    '&:hover': { background: t.colors.action.hover },
    '&:hover [data-actions]': { opacity: 1 },
  }),
  active: css({ background: t.colors.action.selected, '&:hover': { background: t.colors.action.selected } }),
  open: css({
    all: 'unset',
    cursor: 'pointer',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: t.spacing(1),
    padding: t.spacing(0.75, 1),
    '&:focus-visible': { outline: `2px solid ${t.colors.primary.main}` },
  }),
  icon: css({ width: 16, display: 'inline-flex', justifyContent: 'center', color: t.colors.text.secondary }),
  text: css({ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }),
  title: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  meta: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  actions: css({ display: 'flex', alignItems: 'center', gap: t.spacing(0.25), paddingRight: t.spacing(0.5) }),
  hover: css({ opacity: 0, '&:focus-within': { opacity: 1 }, '@media (hover: none)': { opacity: 1 } }),
  rename: css({ display: 'flex', alignItems: 'center', gap: t.spacing(0.5), padding: t.spacing(0.5) }),
  footer: css({ color: t.colors.text.disabled, fontSize: t.typography.bodySmall.fontSize, padding: t.spacing(0, 0.5) }),
});
