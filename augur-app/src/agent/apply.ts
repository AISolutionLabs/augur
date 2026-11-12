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
  /** Save a dashboard draft over this existing dashboard (a later revision of a saved draft)... */
  replaceUid?: string;
  /**
   * ...but only if it is still at this version. If anyone saved it since, Grafana refuses and
   * nothing is overwritten (the same optimistic check as edits to existing dashboards).
   */
  replaceVersion?: number;
}

export interface ApplyResult {
  message: string;
  url: string;
  /** For dashboards: what was saved, so a later revision can update it safely. */
  uid?: string;
  version?: number;
}

/** Raised when a dashboard changed since Augur saved it. */
export class DashboardChangedError extends Error {
  constructor(title: string) {
    super(`"${title}" was changed in Grafana since Augur saved it, so it was not overwritten. Save this revision as a new dashboard, or open the dashboard and ask Augur to edit it from its current state.`);
    this.name = 'DashboardChangedError';
  }
}

export async function applyProposal(http: GrafanaHttp, p: Proposal, opts: ApplyOptions = {}): Promise<ApplyResult> {
  switch (p.kind) {
    case 'dashboard': {
      if (opts.replaceUid) {
        if (opts.replaceVersion === undefined) {
          throw new Error('The version of the saved dashboard is unknown, so it cannot be updated safely. Save this revision as a new dashboard.');
        }
        let r: { url: string; uid: string; version: number };
        try {
          r = await http.post('/api/dashboards/db', {
            dashboard: { ...p.draft.json, id: null, uid: opts.replaceUid, version: opts.replaceVersion },
            folderUid: opts.folderUid ?? p.draft.folderUid ?? '',
            overwrite: false,
            message: `Augur: revision ${p.draft.revision ?? ''}`.trim(),
          });
        } catch (e) {
          if ((e as { status?: number })?.status === 412) {
            throw new DashboardChangedError(p.draft.title);
          }
          throw e;
        }
        return { message: `Updated dashboard "${p.draft.title}" (revision ${p.draft.revision ?? 2})`, url: r.url, uid: r.uid ?? opts.replaceUid, version: r.version };
      }
      const r = await saveDashboard(http, p.draft, opts.folderUid);
      return { message: `Saved dashboard "${p.draft.title}"`, url: r.url, uid: r.uid, version: r.version };
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
