// Applies a proposal through Grafana's HTTP API. In the app this only runs from a user's click on a
// proposal card; the headless runner calls it only when automatic apply is explicitly enabled.

import { GrafanaHttp } from './types';
import { Proposal } from './proposals';
import { saveDashboard } from './dashboard';

export interface ApplyOptions {
  /** Folder for new dashboards and alert rules (overrides the proposal's). */
  folderUid?: string;
  /** Recorded as the silence's creator. */
  login?: string;
  /** Save a dashboard draft over this existing dashboard (unattended revisions of a saved draft). */
  replaceUid?: string;
}

export interface ApplyResult {
  message: string;
  url: string;
}

export async function applyProposal(http: GrafanaHttp, p: Proposal, opts: ApplyOptions = {}): Promise<ApplyResult> {
  switch (p.kind) {
    case 'dashboard': {
      if (opts.replaceUid) {
        const r = await http.post<{ url: string }>('/api/dashboards/db', {
          dashboard: { ...p.draft.json, id: null, uid: opts.replaceUid },
          folderUid: opts.folderUid ?? p.draft.folderUid ?? '',
          overwrite: true,
          message: `Augur: revision ${p.draft.revision ?? ''}`.trim(),
        });
        return { message: `Updated dashboard "${p.draft.title}" (revision ${p.draft.revision ?? 2})`, url: r.url };
      }
      const r = await saveDashboard(http, p.draft, opts.folderUid);
      return { message: `Saved dashboard "${p.draft.title}"`, url: r.url };
    }
    case 'dashboard_edit': {
      const r = await http.post<{ url: string }>('/api/dashboards/db', {
        dashboard: p.json,
        folderUid: p.folderUid ?? '',
        overwrite: false,
        message: `Augur: ${(p as { summary?: string }).summary ?? p.changes.slice(0, 3).join('; ')}`.slice(0, 250),
      });
      return { message: `Applied changes to "${p.title}" (new version; restorable from version history)`, url: r.url };
    }
    case 'silence': {
      const r = await http.post<{ silenceID: string }>('/api/alertmanager/grafana/api/v2/silences', {
        matchers: p.matchers,
        startsAt: new Date().toISOString(),
        endsAt: p.endsAt,
        comment: p.comment,
        createdBy: opts.login ?? 'augur',
      });
      return { message: `Created silence ${r.silenceID ?? ''} until ${p.endsAt}`, url: '/alerting/silences' };
    }
    case 'alert_rule': {
      const r = await http.post<{ uid: string }>(
        '/api/v1/provisioning/alert-rules',
        { ...p.rule, folderUID: opts.folderUid ?? p.rule.folderUID },
        undefined,
        { 'X-Disable-Provenance': 'true' } // keep the rule editable in the UI
      );
      return { message: `Created alert rule "${p.rule.title}"`, url: `/alerting/grafana/${r.uid}/view` };
    }
  }
}
