// Saving an investigation into Grafana as a regular dashboard: shareable, permissioned by folder,
// searchable (tag), versioned, and readable later by Augur itself as "investigation memory".

import { DataSourceInfo, EvidenceRecord, Finding, GrafanaHttp, Hypothesis } from './types';
import { iso } from './time';

export const INVESTIGATION_TAG = 'augur-investigation';

export interface EvidenceQuery {
  tool: string;
  input: Record<string, any>;
  ok: boolean;
}

export interface InvestigationRecord {
  title: string;
  question: string;
  report: string;
  findings: Finding[];
  hypotheses: Hypothesis[];
  evidence: EvidenceQuery[];
  /** Exact queries executed, with absolute ranges and result digests. */
  ledger?: EvidenceRecord[];
  range: { from: number; to: number };
  user?: string;
  tags?: string[];
}

function uid() {
  return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Turns successful evidence queries into dashboard panels (deduplicated, max 12). */
export function evidencePanels(evidence: EvidenceQuery[], datasources: DataSourceInfo[], startY: number) {
  const seen = new Set<string>();
  const panels: any[] = [];
  let y = startY;
  let x = 0;
  let id = 100;
  for (const e of evidence) {
    if (!e.ok || panels.length >= 12) {
      continue;
    }
    const ds = datasources.find((d) => d.uid === e.input.datasource_uid);
    if (!ds) {
      continue;
    }
    let panel: any | undefined;
    if (e.tool === 'query_prometheus' && e.input.expr) {
      panel = { type: 'timeseries', title: String(e.input.expr).slice(0, 80), targets: [{ refId: 'A', expr: e.input.expr, range: true, datasource: { uid: ds.uid, type: ds.type } }], w: 12, h: 8 };
    } else if (e.tool === 'query_loki' && e.input.expr) {
      const isLogs = !/^\s*(sum|count|rate|avg|max|min|topk|bottomk|quantile_over_time|bytes|absent)/.test(e.input.expr);
      panel = {
        type: isLogs ? 'logs' : 'timeseries',
        title: String(e.input.expr).slice(0, 80),
        targets: [{ refId: 'A', expr: e.input.expr, queryType: 'range', datasource: { uid: ds.uid, type: ds.type } }],
        w: isLogs ? 24 : 12,
        h: isLogs ? 10 : 8,
      };
    } else if (e.tool === 'search_traces' && e.input.traceql) {
      panel = { type: 'table', title: `Traces: ${String(e.input.traceql).slice(0, 70)}`, targets: [{ refId: 'A', queryType: 'traceql', query: e.input.traceql, tableType: 'traces', limit: 20, datasource: { uid: ds.uid, type: ds.type } }], w: 24, h: 8 };
    }
    if (!panel) {
      continue;
    }
    const key = `${ds.uid}|${JSON.stringify(panel.targets[0])}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (x + panel.w > 24) {
      x = 0;
      y += 8;
    }
    panels.push({ id: id++, type: panel.type, title: panel.title, datasource: { uid: ds.uid, type: ds.type }, targets: panel.targets, gridPos: { x, y, w: panel.w, h: panel.h }, fieldConfig: { defaults: {}, overrides: [] }, options: {} });
    x += panel.w;
    if (x >= 24) {
      x = 0;
      y += panel.h;
    }
  }
  return panels;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown table of the evidence ledger (shared by saved investigations and exported reports). */
export function ledgerMarkdown(ledger: EvidenceRecord[] = []): string {
  if (!ledger.length) {
    return '_No data queries were recorded._';
  }
  const q = (e: EvidenceRecord) => String(e.query.expr ?? e.query.query ?? JSON.stringify(e.query));
  return [
    '| ID | Datasource | Query | Range (UTC) | Result | Digest |',
    '|---|---|---|---|---|---|',
    ...ledger.map(
      (e) =>
        `| ${e.id}${e.agent ? ` (${e.agent})` : ''} | ${cell(e.datasource.name)} (\`${e.datasource.uid}\`) | \`${cell(q(e)).slice(0, 300)}\` | ${e.from} → ${e.to} | ${e.frames} frames, ${e.rows} rows | \`${e.digest.slice(0, 23)}…\` |`
    ),
  ].join('\n');
}

export function buildInvestigationDashboard(rec: InvestigationRecord, datasources: DataSourceInfo[]) {
  const sev = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const findingsMd = rec.findings.length
    ? [...rec.findings]
        .sort((a, b) => sev[a.severity] - sev[b.severity])
        .map((f) => `- **[${f.severity.toUpperCase()}] ${f.title}**: ${f.detail}${f.evidence ? `\n  - _Evidence:_ \`${f.evidence.replace(/`/g, "'")}\`` : ''}`)
        .join('\n')
    : '_No findings recorded._';
  const hypMd = rec.hypotheses.length
    ? rec.hypotheses.map((h) => `- **${h.status.toUpperCase()}** (${Math.round(h.confidence * 100)}%${h.challenged ? ', challenged' : ''}) ${h.statement}${h.evidence ? ` — ${h.evidence}` : ''}`).join('\n')
    : '_No hypotheses recorded._';
  const header = `**Question:** ${rec.question}\n\n**Window:** ${iso(rec.range.from)} → ${iso(rec.range.to)} · **By:** ${rec.user ?? 'unknown'} with Augur`;
  const panels: any[] = [
    { id: 1, type: 'text', title: 'Report', gridPos: { x: 0, y: 0, w: 24, h: 18 }, options: { mode: 'markdown', content: `${header}\n\n${rec.report}` } },
    { id: 2, type: 'text', title: 'Findings', gridPos: { x: 0, y: 18, w: 12, h: 10 }, options: { mode: 'markdown', content: findingsMd } },
    { id: 3, type: 'text', title: 'Hypotheses', gridPos: { x: 12, y: 18, w: 12, h: 10 }, options: { mode: 'markdown', content: hypMd } },
    { id: 5, type: 'text', title: 'Evidence ledger (exact queries, ranges and result digests)', gridPos: { x: 0, y: 28, w: 24, h: 10 }, options: { mode: 'markdown', content: ledgerMarkdown(rec.ledger) } },
    { id: 4, type: 'row', title: 'Evidence', collapsed: false, gridPos: { x: 0, y: 38, w: 24, h: 1 }, panels: [] },
    ...evidencePanels(rec.evidence, datasources, 39),
  ];
  return {
    id: null,
    uid: uid(),
    title: rec.title.slice(0, 180),
    tags: [INVESTIGATION_TAG, ...(rec.tags ?? [])],
    timezone: 'utc',
    editable: true,
    schemaVersion: 39,
    time: { from: new Date(rec.range.from).toISOString(), to: new Date(rec.range.to).toISOString() },
    annotations: {
      list: [
        { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
      ],
    },
    panels,
  };
}

/** Saves the investigation and marks findings as annotations on it. Returns the dashboard URL. */
export async function saveInvestigation(http: GrafanaHttp, rec: InvestigationRecord, datasources: DataSourceInfo[], folderUid?: string) {
  const dashboard = buildInvestigationDashboard(rec, datasources);
  const r = await http.post<{ uid: string; url: string }>('/api/dashboards/db', { dashboard, folderUid: folderUid ?? '', overwrite: false, message: 'Investigation saved by Augur' });
  for (const f of rec.findings.slice(0, 50)) {
    try {
      await http.post('/api/annotations', { dashboardUID: r.uid, time: f.at, tags: ['augur', f.severity], text: `${f.title}: ${f.detail}` });
    } catch {
      // annotations are a nice-to-have
    }
  }
  return r;
}
