import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { config } from '@grafana/runtime';
import { Alert, Badge, Button, Combobox, ComboboxOption, LinkButton, Stack, useStyles2 } from '@grafana/ui';
import { Proposal, DashboardEditProposal, SilenceProposal, AlertRuleProposal } from '../agent/proposals';
import { grafanaHttp } from '../api';
import { errorMessage } from '../agent/grafana';
import { DraftCard } from './DraftCard';

export interface ProposalProps {
  proposal: Proposal;
  superseded: boolean;
  onApplied: (text: string, url?: string) => void;
}

export function ProposalCard(props: ProposalProps) {
  const p = props.proposal;
  switch (p.kind) {
    case 'dashboard':
      return <DraftCard draft={p.draft} superseded={props.superseded} onSaved={(title, url) => props.onApplied(`Saved dashboard "${title}"`, url)} />;
    case 'dashboard_edit':
      return <EditCard p={p} onApplied={props.onApplied} />;
    case 'silence':
      return <SilenceCard p={p} onApplied={props.onApplied} />;
    case 'alert_rule':
      return <AlertRuleCard p={p} onApplied={props.onApplied} />;
  }
}

function useApply() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<{ url?: string } | undefined>();
  const run = async (fn: () => Promise<{ url?: string } | void>) => {
    setBusy(true);
    setError(undefined);
    try {
      setDone((await fn()) ?? {});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run, dismissed: false };
}

function Shell({ kicker, title, badges, children }: { kicker: string; title: string; badges?: React.ReactNode; children: React.ReactNode }) {
  const s = useStyles2(getStyles);
  return (
    <div className={s.card} data-testid="augur-proposal">
      <Stack justifyContent="space-between" alignItems="center">
        <div>
          <div className={s.kicker}>{kicker}</div>
          <div className={s.title}>{title}</div>
        </div>
        <Stack gap={1}>{badges}</Stack>
      </Stack>
      {children}
    </div>
  );
}

function EditCard({ p, onApplied }: { p: DashboardEditProposal; onApplied: ProposalProps['onApplied'] }) {
  const s = useStyles2(getStyles);
  const a = useApply();
  const [discarded, setDiscarded] = useState(false);
  const bad = p.checks.filter((c) => c.status === 'error' || c.status === 'empty');
  const apply = () =>
    a.run(async () => {
      const r = await grafanaHttp.post<{ url: string }>('/api/dashboards/db', {
        dashboard: p.json,
        folderUid: p.folderUid ?? '',
        overwrite: false,
        message: `Augur: ${(p as any).summary ?? p.changes.slice(0, 3).join('; ')}`.slice(0, 250),
      });
      onApplied(`Applied changes to "${p.title}" (new version; restorable from version history)`, r.url);
      return { url: r.url };
    });
  return (
    <Shell kicker="Proposed dashboard change" title={p.title} badges={<Badge color="blue" text={`based on v${p.baseVersion}`} />}>
      <ul className={s.list}>
        {p.changes.map((c, i) => (
          <li key={i} className={c.startsWith('−') ? s.removed : c.startsWith('+') ? s.added : undefined}>
            {c}
          </li>
        ))}
      </ul>
      {p.warnings.length > 0 && <Alert severity="warning" title="Warnings">{p.warnings.join('; ')}</Alert>}
      {bad.length > 0 && <Alert severity="info" title="Queries without data in the last hour">{bad.map((c) => `${c.panel}: ${c.detail}`).join('; ')}</Alert>}
      {a.error && (
        <Alert severity="error" title="Apply failed">
          {/412|version|changed/i.test(a.error) ? 'The dashboard was changed by someone else since this proposal. Ask Augur to propose the change again.' : a.error}
        </Alert>
      )}
      {a.done ? (
        <LinkButton href={a.done.url} icon="apps">
          Open dashboard
        </LinkButton>
      ) : discarded ? (
        <span className={s.muted}>Discarded.</span>
      ) : (
        <Stack gap={1}>
          <Button icon="check" onClick={apply} disabled={a.busy}>
            {a.busy ? 'Applying…' : 'Apply changes'}
          </Button>
          <LinkButton variant="secondary" fill="outline" href={p.url} target="_blank" icon="external-link-alt">
            View current
          </LinkButton>
          <Button variant="secondary" fill="text" onClick={() => setDiscarded(true)}>
            Discard
          </Button>
        </Stack>
      )}
    </Shell>
  );
}

function SilenceCard({ p, onApplied }: { p: SilenceProposal; onApplied: ProposalProps['onApplied'] }) {
  const s = useStyles2(getStyles);
  const a = useApply();
  const create = () =>
    a.run(async () => {
      const r = await grafanaHttp.post<{ silenceID: string }>('/api/alertmanager/grafana/api/v2/silences', {
        matchers: p.matchers,
        startsAt: new Date().toISOString(),
        endsAt: p.endsAt,
        comment: p.comment,
        createdBy: config.bootData?.user?.login ?? 'augur',
      });
      const url = `/alerting/silences`;
      onApplied(`Created silence ${r.silenceID ?? ''} until ${p.endsAt}`, url);
      return { url };
    });
  return (
    <Shell kicker="Proposed silence" title={p.matchers.map((m) => `${m.name}${m.isEqual ? '' : '!'}${m.isRegex ? '=~' : '='}"${m.value}"`).join(', ')} badges={<Badge color={p.matchingAlerts.length ? 'orange' : 'blue'} text={`${p.matchingAlerts.length} firing alert${p.matchingAlerts.length === 1 ? ' matches' : 's match'}`} />}>
      <div className={s.muted}>
        For {Math.max(1, Math.round((Date.parse(p.endsAt) - Date.parse(p.startsAt)) / 60_000))} min (until {new Date(p.endsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC) · {p.comment}
      </div>
      {p.matchingAlerts.length > 0 && <pre className={s.pre}>{p.matchingAlerts.slice(0, 20).join('\n')}</pre>}
      {a.error && <Alert severity="error" title="Create failed">{a.error}</Alert>}
      {a.done ? (
        <LinkButton href={a.done.url} icon="bell-slash">
          View silences
        </LinkButton>
      ) : (
        <Stack gap={1}>
          <Button icon="bell-slash" onClick={create} disabled={a.busy}>
            {a.busy ? 'Creating…' : 'Create silence'}
          </Button>
        </Stack>
      )}
    </Shell>
  );
}

function AlertRuleCard({ p, onApplied }: { p: AlertRuleProposal; onApplied: ProposalProps['onApplied'] }) {
  const s = useStyles2(getStyles);
  const a = useApply();
  const [folders, setFolders] = useState<Array<ComboboxOption<string>>>([]);
  const [folder, setFolder] = useState<string>(p.rule.folderUID);
  useEffect(() => {
    grafanaHttp
      .get<Array<{ uid: string; title: string; folderTitle?: string }>>('/api/search', { type: 'dash-folder', limit: 500 })
      .then((hits) => setFolders(hits.map((h) => ({ label: h.folderTitle ? `${h.folderTitle} / ${h.title}` : h.title, value: h.uid }))))
      .catch(() => undefined);
  }, []);
  const create = () =>
    a.run(async () => {
      const r = await grafanaHttp.post<{ uid: string }>(
        '/api/v1/provisioning/alert-rules',
        { ...p.rule, folderUID: folder },
        undefined,
        { 'X-Disable-Provenance': 'true' } // keep the rule editable in the UI
      );
      const url = `/alerting/grafana/${r.uid}/view`;
      onApplied(`Created alert rule "${p.rule.title}"`, url);
      return { url };
    });
  return (
    <Shell kicker="Proposed alert rule" title={p.rule.title} badges={<Badge color="purple" text={p.rule.for ? `for ${p.rule.for}` : ''} />}>
      <ul className={s.list}>{p.summary.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <div className={s.caption}>Current evaluation</div>
      <pre className={s.pre}>{p.preview}</pre>
      {a.error && <Alert severity="error" title="Create failed">{a.error}</Alert>}
      {a.done ? (
        <LinkButton href={a.done.url} icon="bell">
          Open alert rule
        </LinkButton>
      ) : (
        <Stack gap={1} alignItems="center">
          {folders.length > 0 && (
            <div className={s.folder}>
              <Combobox options={folders} value={folder} onChange={(v) => setFolder(v.value)} aria-label="Folder" />
            </div>
          )}
          <Button icon="bell" onClick={create} disabled={a.busy || !folder}>
            {a.busy ? 'Creating…' : 'Create alert rule'}
          </Button>
        </Stack>
      )}
    </Shell>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  card: css({
    border: `1px solid ${t.colors.border.medium}`,
    borderRadius: t.shape.radius.default,
    background: t.colors.background.secondary,
    padding: t.spacing(2),
    display: 'flex',
    flexDirection: 'column',
    gap: t.spacing(1.5),
  }),
  kicker: css({ fontSize: t.typography.bodySmall.fontSize, color: t.colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.04em' }),
  title: css({ fontSize: t.typography.h5.fontSize, fontWeight: t.typography.fontWeightMedium, wordBreak: 'break-word' }),
  list: css({ margin: 0, paddingLeft: t.spacing(2), fontSize: t.typography.bodySmall.fontSize, fontFamily: t.typography.fontFamilyMonospace }),
  added: css({ color: t.colors.success.text }),
  removed: css({ color: t.colors.error.text }),
  muted: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize }),
  caption: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize }),
  pre: css({ fontSize: 11, maxHeight: 200, overflow: 'auto', margin: 0 }),
  folder: css({ minWidth: 240 }),
});
