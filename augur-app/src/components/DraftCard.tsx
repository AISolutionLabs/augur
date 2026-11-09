import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Badge, Button, ClipboardButton, Combobox, ComboboxOption, LinkButton, Stack, useStyles2 } from '@grafana/ui';
import { DashboardDraft, saveDashboard } from '../agent/dashboard';
import { grafanaHttp } from '../api';
import { errorMessage } from '../agent/grafana';

interface Props {
  draft: DashboardDraft;
  superseded: boolean;
  onSaved: (title: string, url: string) => void;
}

export function DraftCard({ draft, superseded, onSaved }: Props) {
  const s = useStyles2(getStyles);
  const [folders, setFolders] = useState<Array<ComboboxOption<string>>>([{ label: 'Dashboards (root)', value: '' }]);
  const [folder, setFolder] = useState<string>(draft.folderUid ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ url: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    grafanaHttp
      .get<Array<{ uid: string; title: string; folderTitle?: string }>>('/api/search', { type: 'dash-folder', limit: 500 })
      .then((hits) =>
        setFolders([{ label: 'Dashboards (root)', value: '' }, ...hits.map((h) => ({ label: h.folderTitle ? `${h.folderTitle} / ${h.title}` : h.title, value: h.uid }))])
      )
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const r = await saveDashboard(grafanaHttp, draft, folder);
      setSaved({ url: r.url });
      onSaved(draft.title, r.url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const ok = draft.checks.filter((c) => c.status === 'ok').length;
  const bad = draft.checks.filter((c) => c.status === 'error' || c.status === 'empty');

  return (
    <div className={s.card} data-testid="claude-draft-card">
      <Stack justifyContent="space-between" alignItems="center">
        <div>
          <div className={s.kicker}>Dashboard draft{superseded ? ' · superseded by a newer draft' : ''}</div>
          <div className={s.title}>{draft.title}</div>
        </div>
        <Stack gap={1}>
          {draft.checks.length > 0 && <Badge color={bad.length ? 'orange' : 'green'} text={`${ok}/${draft.checks.length} queries returned data`} />}
          {draft.basedOn && <Badge color="blue" text={`copy of ${draft.basedOn}`} />}
        </Stack>
      </Stack>

      <pre className={s.outline}>{draft.outline.join('\n')}</pre>

      {draft.warnings.length > 0 && (
        <Alert severity="warning" title="Warnings">
          <ul>{draft.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Alert>
      )}
      {bad.length > 0 && (
        <Alert severity="info" title="Queries without data in the last hour">
          <ul>{bad.map((c, i) => <li key={i}><b>{c.panel}</b>: {c.status} — {c.detail}</li>)}</ul>
        </Alert>
      )}
      {error && <Alert severity="error" title="Save failed">{error}</Alert>}

      {!superseded && (
        <Stack gap={1} alignItems="center" wrap="wrap">
          {saved ? (
            <LinkButton href={saved.url} icon="apps" variant="primary">
              Open saved dashboard
            </LinkButton>
          ) : (
            <>
              <div className={s.folder}>
                <Combobox options={folders} value={folder} onChange={(v) => setFolder(v.value)} aria-label="Folder" />
              </div>
              <Button icon="save" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save as new dashboard'}
              </Button>
            </>
          )}
          <Button variant="secondary" fill="outline" icon="brackets-curly" onClick={() => setShowJson(!showJson)}>
            {showJson ? 'Hide JSON' : 'JSON'}
          </Button>
          <ClipboardButton variant="secondary" fill="outline" icon="copy" getText={() => JSON.stringify(draft.json, null, 2)}>
            Copy JSON
          </ClipboardButton>
        </Stack>
      )}
      {showJson && <pre className={s.json}>{JSON.stringify(draft.json, null, 2)}</pre>}
    </div>
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
  title: css({ fontSize: t.typography.h4.fontSize, fontWeight: t.typography.fontWeightMedium }),
  outline: css({ fontSize: 12, maxHeight: 260, overflow: 'auto', margin: 0 }),
  json: css({ fontSize: 11, maxHeight: 400, overflow: 'auto' }),
  folder: css({ minWidth: 260 }),
});
