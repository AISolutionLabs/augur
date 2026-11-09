import { EvidenceRecord, Finding } from './agent/types';
import { ledgerMarkdown } from './agent/investigations';
import { iso } from './agent/time';

export interface ReportInput {
  title: string;
  question: string;
  range: { from: number; to: number };
  finalAnswer: string;
  findings: Finding[];
  queries: Array<{ label: string; ok: boolean }>;
  ledger?: EvidenceRecord[];
  user?: string;
  generatedAt: number;
}

/** Markdown report for an investigation: final write-up, findings log and every query run. */
export function buildReport(r: ReportInput): string {
  const sev = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const lines = [
    `# ${r.title}`,
    '',
    `- **Question:** ${r.question}`,
    `- **Window:** ${iso(r.range.from)} → ${iso(r.range.to)}`,
    `- **Generated:** ${iso(r.generatedAt)}${r.user ? ` by ${r.user}` : ''} with Claude in Grafana`,
    '',
    r.finalAnswer.trim() || '_No final write-up was produced._',
    '',
  ];
  if (r.findings.length) {
    lines.push('## Findings log', '');
    [...r.findings]
      .sort((a, b) => sev[a.severity] - sev[b.severity] || a.at - b.at)
      .forEach((f) => {
        lines.push(`- **[${f.severity.toUpperCase()}] ${f.title}**: ${f.detail}`);
        if (f.evidence) {
          lines.push(`  - Evidence: ${f.evidence}`);
        }
      });
    lines.push('');
  }
  if (r.ledger?.length) {
    lines.push('## Evidence ledger', '', ledgerMarkdown(r.ledger), '');
  }
  if (r.queries.length) {
    lines.push('## Queries executed', '');
    r.queries.forEach((q) => lines.push(`- ${q.ok ? '' : '(failed) '}\`${q.label.replace(/`/g, "'")}\``));
  }
  return lines.join('\n');
}

export function download(filename: string, text: string, type = 'text/markdown') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
