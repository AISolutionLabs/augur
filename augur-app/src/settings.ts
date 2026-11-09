// Org-wide Augur settings live in the app plugin's jsonData:
//  - readable by every signed-in user (GET /api/plugins/<id>/settings)
//  - writable by org admins in the app's config page, or provisioned from Git via apps.yaml
// Personal rules are kept per browser in localStorage.

import { GrafanaHttp } from './agent/types';
import { PLUGIN_ID } from './constants';

export type RuleScope = 'all' | 'chat' | 'investigate' | 'dashboards';

export interface Rule {
  id: string;
  text: string;
  scope: RuleScope;
  enabled: boolean;
}

export interface Skill {
  /** slug used as /command, e.g. "kafka-lag" */
  name: string;
  title: string;
  description: string;
  tags?: string[];
  /** Markdown instructions */
  body: string;
  enabled: boolean;
}

export interface ServiceEntry {
  name: string;
  sources: string[]; // e.g. ["metrics:mimir", "logs:loki", "traces:tempo"]
  namespaces?: string[];
}

export interface InfraMemory {
  scannedAt: number;
  scannedBy?: string;
  summary: string;
  services: ServiceEntry[];
  edges: Array<{ client: string; server: string; rps?: number; errorRate?: number }>;
  datasources: Array<{ uid: string; name: string; type: string; notes: string[] }>;
}

export interface AugurSettings {
  rules?: Rule[];
  skills?: Skill[];
  memory?: InfraMemory;
  /** Folder for saved investigations */
  investigationFolderUid?: string;
  stepBudget?: { chat?: number; investigate?: number };
  /** Token ceiling per run (input + output + cache writes, cache reads weighted 10%). Default 1.5M. */
  maxTokensPerRun?: number;
  /** Allow sub-agents in investigations (default true) */
  enableSubAgents?: boolean;
}

export async function loadSettings(http: GrafanaHttp): Promise<AugurSettings> {
  try {
    const r = await http.get<{ jsonData?: AugurSettings }>(`/api/plugins/${PLUGIN_ID}/settings`);
    return r?.jsonData ?? {};
  } catch {
    return {};
  }
}

export async function saveSettings(http: GrafanaHttp, settings: AugurSettings): Promise<void> {
  await http.post(`/api/plugins/${PLUGIN_ID}/settings`, { enabled: true, pinned: true, jsonData: settings });
}

const PERSONAL_RULES_KEY = `${PLUGIN_ID}/personal-rules`;

export function loadPersonalRules(): Rule[] {
  try {
    return JSON.parse(localStorage.getItem(PERSONAL_RULES_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function savePersonalRules(rules: Rule[]) {
  try {
    localStorage.setItem(PERSONAL_RULES_KEY, JSON.stringify(rules));
  } catch {
    // ignore: storage unavailable
  }
}

export function activeRules(rules: Rule[] | undefined, mode: 'chat' | 'investigate'): Rule[] {
  return (rules ?? []).filter((r) => r.enabled && r.text.trim() && (r.scope === 'all' || r.scope === mode || r.scope === 'dashboards'));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const DEFAULT_MAX_TOKENS_PER_RUN = 1_500_000;

/** Effective token count for budgeting: cache reads are cheap, so they count at 10%. */
export function effectiveTokens(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number {
  return u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + Math.round(u.cache_read_input_tokens * 0.1);
}
