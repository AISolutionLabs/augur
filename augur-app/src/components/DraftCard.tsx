import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Badge, Button, ClipboardButton, Combobox, ComboboxOption, LinkButton, Stack, useStyles2 } from '@grafana/ui';
import { DashboardDraft } from '../agent/dashboard';
import { applyProposal } from '../agent/apply';
import { grafanaHttp } from '../api';
import { errorMessage } from '../agent/grafana';
import { DraftPreview } from './DraftPreview';

const SAVED_KEY = 'augur-assistant-app/saved-drafts';
const MAX_SAVED = 100;

interface SavedDraft {
  uid: string;
  url: string;
  revision: number;
  at: number;
}

/** Where each draft lineage was saved, so later revisions can update that dashboard. */
function readSaved(): Record<string, SavedDraft> {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function writeSaved(lineage: string, entry: SavedDraft) {
  try {
    const all = { ...readSaved(), [lineage]: entry };
    const keep = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_SAVED);
    localStorage.setItem(SAVED_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // storage full or unavailable: saving still worked, only the "update" shortcut is lost
  }
}

interface Props {
  draft: DashboardDraft;
  superseded: boolean;
  onSaved: (message: string, url: string) => void;
}

export function DraftCard({ draft, superseded, onSaved }: Props) {
  const s = useStyles2(getStyles);
  const [folders, setFolders] = useState<Array<ComboboxOption<string>>>([{ label: 'Dashboards (root)', value: '' }]);
  const [folder, setFolder] = useState<string>(draft.folderUid ?? '');
  const [saving, setSaving] = useState(false);
  const lineage = draft.lineage ?? draft.id;
  const [prior, setPrior] = useState<SavedDraft | undefined>(() => readSaved()[lineage]);
  // This exact revision is already saved (e.g. after a reload): show "Open" rather than "Save".
  const [saved, setSaved] = useState<{ url: string } | undefined>(() =>
    prior && prior.revision === (draft.revision ?? 1) ? { url: prior.url } : undefined
  );
  const [error, setError] = useState<string | undefined>();
  const [showJson, setShowJson] = useState(false);
  const [showPreview, setShowPreview] = useState(!superseded);
  const revision = draft.revision ?? 1;

  useEffect(() => {
    grafanaHttp
      .get<Array<{ uid: string; title: string; folderTitle?: string }>>('/api/search', { type: 'dash-folder', limit: 500 })
      .then((hits) =>
        setFolders([{ label: 'Dashboards (root)', value: '' }, ...hits.map((h) => ({ label: h.folderTitle ? `${h.folderTitle} / ${h.title}` : h.title, value: h.uid }))])
      )
      .catch(() => undefined);
  }, []);

  const save = async (replace: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      const replaceUid = replace ? prior?.uid : undefined;
      const r = await applyProposal(grafanaHttp, { kind: 'dashboard', id: draft.id, draft }, { folderUid: folder, replaceUid });
      const uid = replaceUid ?? /\/d\/([^/]+)/.exec(r.url)?.[1] ?? draft.json.uid;
      const entry = { uid, url: r.url, revision, at: Date.now() };
      writeSaved(lineage, entry);
      setPrior(entry);
      setSaved({ url: r.url });
      onSaved(r.message, r.url);
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
          <div className={s.kicker}>
            Dashboard draft{revision > 1 ? ` · revision ${revision}` : ''}
            {superseded ? ' · superseded by a newer draft' : ''}
          </div>
          <div className={s.title}>{draft.title}</div>
        </div>
        <Stack gap={1}>
          {draft.checks.length > 0 && <Badge color={bad.length ? 'orange' : 'green'} text={`${ok}/${draft.checks.length} queries returned data`} />}
          {draft.basedOn && <Badge color="blue" text={`copy of ${draft.basedOn}`} />}
        </Stack>
      </Stack>

      {showPreview && !superseded ? <DraftPreview key={draft.id} json={draft.json} /> : <pre className={s.outline}>{draft.outline.join('\n')}</pre>}

      {draft.fixes && draft.fixes.length > 0 && (
        <details className={s.fixes}>
          <summary>{draft.fixes.length} automatic fixes</summary>
          <ul>{draft.fixes.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </details>
      )}

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
              {prior ? (
                <>
                  <Button icon="save" onClick={() => save(true)} disabled={saving} tooltip={`Overwrites the dashboard saved from revision ${prior.revision}`}>
                    {saving ? 'Saving…' : 'Update saved dashboard'}
                  </Button>
                  <Button variant="secondary" onClick={() => save(false)} disabled={saving}>
                    Save as new
                  </Button>
                </>
              ) : (
                <Button icon="save" onClick={() => save(false)} disabled={saving}>
                  {saving ? 'Saving…' : 'Save as new dashboard'}
                </Button>
              )}
            </>
          )}
          <Button variant="secondary" fill="outline" icon={showPreview ? 'list-ul' : 'eye'} onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? 'Outline' : 'Preview'}
          </Button>
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
  fixes: css({ fontSize: t.typography.bodySmall.fontSize, color: t.colors.text.secondary, ul: { margin: 0, paddingLeft: t.spacing(2) } }),
});
