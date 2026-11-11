import { buildReport, printHtml, reportHtml, ReportInput } from './report';

const input: ReportInput = {
  title: 'Investigation: why is checkout slow?',
  question: 'why is checkout slow?',
  range: { from: Date.UTC(2026, 10, 11, 8), to: Date.UTC(2026, 10, 11, 9) },
  finalAnswer: '## Root cause\n\nThe **v2.4.0** deploy doubled DB calls.\n\n<script>alert(1)</script>',
  findings: [
    { title: 'Minor', detail: 'noise', severity: 'low', at: 2 },
    { title: 'Latency <p95> up', detail: 'from 200ms to 1.4s', severity: 'critical', evidence: 'E1', at: 1 },
  ],
  hypotheses: [
    { id: 'h1', statement: 'Cache miss storm', status: 'refuted', confidence: 0.1, updatedAt: 1 },
    { id: 'h2', statement: 'Deploy v2.4.0 regression', status: 'confirmed', confidence: 0.92, evidence: 'E1, E2', challenged: true, updatedAt: 2 },
  ],
  queries: [
    { label: 'histogram_quantile(0.95, …)', ok: true },
    { label: 'bad{', ok: false },
  ],
  ledger: [
    {
      id: 'E1',
      tool: 'query_prometheus',
      datasource: { uid: 'mimir', type: 'prometheus', name: 'Mimir' },
      query: { expr: 'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))' },
      from: '2026-11-11T08:00:00Z',
      to: '2026-11-11T09:00:00Z',
      digest: 'sha256:0123456789abcdef0123456789abcdef',
      frames: 1,
      rows: 60,
      at: 1,
    },
  ],
  user: 'anirudh',
  generatedAt: Date.UTC(2026, 10, 11, 9, 5),
};

describe('investigation report', () => {
  it('markdown lists findings by severity and hypotheses by status', () => {
    const md = buildReport(input);
    expect(md.indexOf('[CRITICAL]')).toBeLessThan(md.indexOf('[LOW]'));
    expect(md).toContain('## Hypotheses');
    expect(md.indexOf('**CONFIRMED** (92%, challenged) Deploy v2.4.0 regression — E1, E2')).toBeLessThan(md.indexOf('**REFUTED**'));
  });

  it('printable HTML renders the write-up, escapes model text and strips scripts', () => {
    const html = reportHtml(input);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('@page');
    expect(html).toMatch(/<h2[^>]*>Root cause<\/h2>/);
    expect(html).toContain('<strong>v2.4.0</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Latency &lt;p95&gt; up');
    expect(html.indexOf('sev-critical')).toBeLessThan(html.indexOf('sev-low'));
    expect(html.indexOf('hyp-confirmed')).toBeLessThan(html.indexOf('hyp-refuted'));
    expect(html).toContain('<th>Frames / rows</th>');
    expect(html).toContain('sha256:0123456789abcdef');
    expect(html).toMatch(/<li class="failed"><b>failed<\/b> <code>bad\{<\/code><\/li>/);
    expect(html).toContain('2026-11-11T08:00:00');
    expect(html).toContain('by anirudh');
  });

  it('omits empty sections', () => {
    const html = reportHtml({ ...input, findings: [], hypotheses: [], ledger: [], queries: [], finalAnswer: '' });
    expect(html).not.toContain('<h2>Findings</h2>');
    expect(html).not.toContain('Evidence ledger');
    expect(html).toContain('No final write-up was produced');
  });

  it('prints through a hidden iframe and removes it afterwards', () => {
    jest.useFakeTimers();
    const frame = printHtml('<!DOCTYPE html><p>hi</p>');
    expect(document.body.contains(frame)).toBe(true);
    expect(frame.style.visibility).toBe('hidden');
    expect(frame.srcdoc).toContain('<p>hi</p>');
    const print = jest.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { print, focus: jest.fn(), addEventListener: jest.fn() } });
    frame.onload!(new Event('load'));
    expect(print).toHaveBeenCalled();
    jest.advanceTimersByTime(61_000);
    expect(document.body.contains(frame)).toBe(false);
    jest.useRealTimers();
  });
});
