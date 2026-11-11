import { renderMarkdown } from '@grafana/data';
import { EvidenceRecord, Finding, Hypothesis } from './agent/types';
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
  hypotheses?: Hypothesis[];
  user?: string;
  generatedAt: number;
}

const SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
const HYP = { confirmed: 0, supported: 1, open: 2, refuted: 3 } as const;

const sortFindings = (f: Finding[]) => [...f].sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.at - b.at);
const sortHypotheses = (h: Hypothesis[]) => [...h].sort((a, b) => HYP[a.status] - HYP[b.status] || b.confidence - a.confidence);

/** Markdown report for an investigation: final write-up, findings log, hypotheses and every query run. */
export function buildReport(r: ReportInput): string {
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
    sortFindings(r.findings).forEach((f) => {
      lines.push(`- **[${f.severity.toUpperCase()}] ${f.title}**: ${f.detail}`);
      if (f.evidence) {
        lines.push(`  - Evidence: ${f.evidence}`);
      }
    });
    lines.push('');
  }
  if (r.hypotheses?.length) {
    lines.push('## Hypotheses', '');
    sortHypotheses(r.hypotheses).forEach((h) =>
      lines.push(`- **${h.status.toUpperCase()}** (${Math.round(h.confidence * 100)}%${h.challenged ? ', challenged' : ''}) ${h.statement}${h.evidence ? ` — ${h.evidence}` : ''}`)
    );
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

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A standalone, print-styled HTML version of the report, meant to be printed to PDF. The model's
 * write-up goes through Grafana's sanitising Markdown renderer; everything else is escaped.
 */
export function reportHtml(r: ReportInput): string {
  const findings = sortFindings(r.findings)
    .map(
      (f) =>
        `<li class="finding"><span class="sev sev-${f.severity}">${esc(f.severity)}</span> <b>${esc(f.title)}</b><div>${esc(f.detail)}</div>${
          f.evidence ? `<div class="muted">Evidence: <code>${esc(f.evidence)}</code></div>` : ''
        }</li>`
    )
    .join('');
  const hypotheses = sortHypotheses(r.hypotheses ?? [])
    .map(
      (h) =>
        `<tr><td><span class="hyp hyp-${h.status}">${esc(h.status)}</span></td><td class="num">${Math.round(h.confidence * 100)}%${h.challenged ? '<br><span class="muted">challenged</span>' : ''}</td><td>${esc(h.statement)}${
          h.evidence ? `<div class="muted">${esc(h.evidence)}</div>` : ''
        }</td></tr>`
    )
    .join('');
  const q = (e: EvidenceRecord) => String(e.query.expr ?? e.query.query ?? JSON.stringify(e.query));
  const ledger = (r.ledger ?? [])
    .map(
      (e) =>
        `<tr><td>${esc(e.id)}${e.agent ? `<br><span class="muted">${esc(e.agent)}</span>` : ''}</td><td>${esc(e.datasource.name)}</td><td><code>${esc(q(e).slice(0, 400))}</code></td><td class="nowrap">${esc(e.from)}<br>${esc(
          e.to
        )}</td><td class="num">${e.frames} / ${e.rows}</td><td><code>${esc(e.digest.slice(0, 23))}…</code></td></tr>`
    )
    .join('');
  const queries = r.queries.map((x) => `<li${x.ok ? '' : ' class="failed"'}>${x.ok ? '' : '<b>failed</b> '}<code>${esc(x.label)}</code></li>`).join('');
  const answer = r.finalAnswer.trim() ? renderMarkdown(r.finalAnswer) : '<p class="muted"><i>No final write-up was produced.</i></p>';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.title)}</title>
<style>
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Inter, Helvetica, Arial, sans-serif; color: #1f2328; margin: 0; }
header { border-bottom: 2px solid #1f2328; padding-bottom: 8px; margin-bottom: 14px; }
.brand { font-size: 8.5pt; letter-spacing: .08em; text-transform: uppercase; color: #59636e; }
h1 { font-size: 17pt; margin: 2px 0 6px; line-height: 1.25; }
h2 { font-size: 12.5pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d1d9e0; break-after: avoid; }
h3, h4 { font-size: 11pt; break-after: avoid; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 9.5pt; }
dt { color: #59636e; } dd { margin: 0; }
code, pre { font: 8.5pt/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
pre { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 4px; padding: 6px 8px; break-inside: avoid; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin: 6px 0; }
th, td { border: 1px solid #d1d9e0; padding: 3px 5px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #f6f8fa; } tr { break-inside: avoid; } thead { display: table-header-group; }
.num { text-align: right; white-space: nowrap; } .nowrap { white-space: nowrap; }
.muted { color: #59636e; font-size: 9pt; }
ul.findings { list-style: none; padding: 0; } .finding { margin: 0 0 8px; break-inside: avoid; }
.sev, .hyp { display: inline-block; font-size: 7.5pt; font-weight: 600; text-transform: uppercase; border-radius: 3px; padding: 0 5px; color: #fff; background: #59636e; }
.sev-critical { background: #82071e; } .sev-high { background: #cf222e; } .sev-medium { background: #bc4c00; } .sev-low { background: #9a6700; } .sev-info { background: #0969da; }
.hyp-confirmed { background: #1a7f37; } .hyp-supported { background: #2da44e; } .hyp-open { background: #59636e; } .hyp-refuted { background: #8c959f; }
li.failed code { color: #cf222e; }
footer { margin-top: 18px; border-top: 1px solid #d1d9e0; padding-top: 6px; font-size: 8pt; color: #59636e; }
a { color: #0969da; text-decoration: none; }
</style></head><body>
<header><div class="brand">Augur · investigation report</div><h1>${esc(r.title)}</h1>
<dl><dt>Question</dt><dd>${esc(r.question)}</dd><dt>Window (UTC)</dt><dd>${esc(iso(r.range.from))} → ${esc(iso(r.range.to))}</dd><dt>Generated</dt><dd>${esc(iso(r.generatedAt))}${
    r.user ? ` by ${esc(r.user)}` : ''
  }</dd></dl></header>
<section class="answer">${answer}</section>
${findings ? `<h2>Findings</h2><ul class="findings">${findings}</ul>` : ''}
${hypotheses ? `<h2>Hypotheses</h2><table><thead><tr><th>Status</th><th>Confidence</th><th>Hypothesis</th></tr></thead><tbody>${hypotheses}</tbody></table>` : ''}
${
  ledger
    ? `<h2>Evidence ledger</h2><table><thead><tr><th>ID</th><th>Datasource</th><th>Query</th><th>Range</th><th>Frames / rows</th><th>Digest</th></tr></thead><tbody>${ledger}</tbody></table>`
    : ''
}
${queries ? `<h2>Queries executed</h2><ul>${queries}</ul>` : ''}
<footer>Generated by Augur in Grafana. Evidence digests identify the exact data each claim was based on.</footer>
</body></html>`;
}

/**
 * Opens the browser's print dialog for a standalone HTML document (choose "Save as PDF"), using a
 * hidden iframe so no popup blocker is involved and the Grafana page itself is not printed.
 */
export function printHtml(html: string, doc: Document = document): HTMLIFrameElement {
  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Report print preview';
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', visibility: 'hidden' });
  const cleanup = () => setTimeout(() => frame.remove(), 500);
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) {
      cleanup();
      return;
    }
    w.addEventListener('afterprint', cleanup);
    w.focus();
    w.print();
    // Some browsers don't fire afterprint; never leave the frame behind for long.
    setTimeout(cleanup, 60_000);
  };
  frame.srcdoc = html;
  doc.body.appendChild(frame);
  return frame;
}
