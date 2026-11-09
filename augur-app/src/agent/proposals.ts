// Write actions are never executed by the model. Tools produce *proposals* that the UI renders as
// cards; only a user click applies them, using the user's own Grafana permissions.

import { DashboardDraft } from './dashboard';

export interface DashboardEditProposal {
  kind: 'dashboard_edit';
  id: string;
  dashboardUid: string;
  title: string;
  folderUid?: string;
  baseVersion: number;
  json: Record<string, any>;
  changes: string[];
  warnings: string[];
  checks: Array<{ panel: string; query: string; status: string; detail?: string }>;
  url: string;
}

export interface SilenceProposal {
  kind: 'silence';
  id: string;
  matchers: Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }>;
  startsAt: string;
  endsAt: string;
  comment: string;
  matchingAlerts: string[];
}

export interface AlertRuleProposal {
  kind: 'alert_rule';
  id: string;
  rule: Record<string, any>;
  summary: string[];
  preview: string;
}

export type Proposal = { kind: 'dashboard'; id: string; draft: DashboardDraft } | DashboardEditProposal | SilenceProposal | AlertRuleProposal;

export function proposalId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`;
}
