// Compact, model-friendly summaries of Grafana /api/ds/query responses.
// Raw frames can be megabytes; the model needs shape, labels, stats and a few samples.

import { iso } from './time';

export interface RawField {
  name: string;
  type?: string;
  labels?: Record<string, string>;
  config?: { displayNameFromDS?: string; unit?: string };
  typeInfo?: { frame?: string };
}

export interface RawFrame {
  schema?: { name?: string; refId?: string; meta?: Record<string, any>; fields: RawField[] };
  data?: { values: unknown[][] };
}

export interface DsQueryResponse {
  results?: Record<string, { status?: number; error?: string; frames?: RawFrame[] }>;
}

export function framesOf(resp: DsQueryResponse, refId = 'A'): RawFrame[] {
  const r = resp?.results?.[refId];
  if (!r) {
    return [];
  }
  if (r.error) {
    throw new Error(r.error);
  }
  return r.frames ?? [];
}

const fmtLabels = (l?: Record<string, string>) =>
  l && Object.keys(l).length
    ? '{' +
      Object.entries(l)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ') +
      '}'
    : '{}';

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n * 10) / 10 : Math.round(n * 10000) / 10000);

function stats(values: number[]) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) {
    return undefined;
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of nums) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  return { min: round(min), max: round(max), avg: round(sum / nums.length), last: round(nums[nums.length - 1]), n: nums.length };
}

function downsample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) {
    return arr;
  }
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}

/** Summarises numeric time series frames (Prometheus/Mimir, Loki metric queries). */
export function summarizeTimeSeries(frames: RawFrame[], opts: { maxSeries?: number; samples?: number } = {}): string {
  const maxSeries = opts.maxSeries ?? 25;
  const samples = opts.samples ?? 12;
  type Series = { labels: string; stats: NonNullable<ReturnType<typeof stats>>; points: Array<[number, number]>; peakAt?: number };
  const series: Series[] = [];

  for (const f of frames) {
    const fields = f.schema?.fields ?? [];
    const values = f.data?.values ?? [];
    const tIdx = fields.findIndex((x) => x.type === 'time');
    fields.forEach((field, i) => {
      if (field.type !== 'number') {
        return;
      }
      const ys = (values[i] ?? []) as number[];
      const st = stats(ys);
      if (!st) {
        return;
      }
      const ts = tIdx >= 0 ? ((values[tIdx] ?? []) as number[]) : [];
      const pts: Array<[number, number]> = ys.map((y, j) => [ts[j], y]);
      let peakAt: number | undefined;
      if (ts.length) {
        let best = -Infinity;
        ys.forEach((y, j) => {
          if (typeof y === 'number' && y > best) {
            best = y;
            peakAt = ts[j];
          }
        });
      }
      const name = field.config?.displayNameFromDS ?? (field.labels && Object.keys(field.labels).length ? '' : field.name);
      series.push({ labels: (name ? name + ' ' : '') + fmtLabels(field.labels), stats: st, points: pts, peakAt });
    });
  }

  if (!series.length) {
    return 'No data (0 series). Check the selector, labels and time range.';
  }
  series.sort((a, b) => b.stats.max - a.stats.max);
  const lines: string[] = [`${series.length} series${series.length > maxSeries ? ` (showing top ${maxSeries} by max)` : ''}:`];
  for (const s of series.slice(0, maxSeries)) {
    const st = s.stats;
    lines.push(
      `- ${s.labels}: min=${st.min} max=${st.max} avg=${st.avg} last=${st.last} points=${st.n}` +
        (s.peakAt ? ` peak_at=${iso(s.peakAt)}` : '')
    );
    if (s.points.length > 1 && s.points[0][0] !== undefined) {
      const ds = downsample(s.points, samples)
        .map(([t, y]) => `${iso(t).slice(11, 16)}=${typeof y === 'number' ? round(y) : y}`)
        .join(' ');
      lines.push(`  samples: ${ds}`);
    }
  }
  return lines.join('\n');
}

/** True when a frame looks like Loki log lines rather than a metric result. */
export function isLogFrame(f: RawFrame): boolean {
  const fields = f.schema?.fields ?? [];
  return (
    f.schema?.meta?.type === 'log-lines' ||
    f.schema?.meta?.preferredVisualisationType === 'logs' ||
    fields.some((x) => x.name === 'Line' || x.name === 'body')
  );
}

/** Summarises Loki log frames: newest lines first, labels condensed, long lines clipped. */
export function summarizeLogs(frames: RawFrame[], limit: number, lineChars = 400): string {
  type Row = { t: number; labels: string; line: string };
  const rows: Row[] = [];
  const labelCounts = new Map<string, number>();

  for (const f of frames) {
    const fields = f.schema?.fields ?? [];
    const values = f.data?.values ?? [];
    const idx = (n: string[]) => fields.findIndex((x) => n.includes(x.name));
    const tI = fields.findIndex((x) => x.type === 'time');
    const lineI = idx(['Line', 'body']);
    const labI = idx(['labels', 'attributes']);
    const n = (values[lineI] ?? []).length;
    for (let j = 0; j < n; j++) {
      const lab = (labI >= 0 ? values[labI]?.[j] : undefined) as Record<string, string> | undefined;
      const labStr = lab ? fmtLabels(pickInterestingLabels(lab)) : fmtLabels(fields[lineI]?.labels);
      labelCounts.set(labStr, (labelCounts.get(labStr) ?? 0) + 1);
      rows.push({ t: Number(values[tI]?.[j] ?? 0), labels: labStr, line: String(values[lineI]?.[j] ?? '') });
    }
  }
  if (!rows.length) {
    return 'No log lines matched. Check the stream selector and filters, or widen the time range.';
  }
  rows.sort((a, b) => b.t - a.t);
  const shown = rows.slice(0, limit);
  const out = [`${rows.length} lines returned (newest first, showing ${shown.length}). Streams:`];
  [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([l, c]) => out.push(`  ${c}× ${l}`));
  out.push('Lines:');
  for (const r of shown) {
    const line = r.line.length > lineChars ? r.line.slice(0, lineChars) + '…' : r.line;
    out.push(`${r.t ? iso(r.t) : '?'} ${labelCounts.size > 1 ? r.labels + ' ' : ''}${line.replace(/\s+/g, ' ')}`);
  }
  return out.join('\n');
}

const NOISY_LABEL = /^(__|filename$|stream$|job$|instance$|pod_template_hash|controller_revision_hash|detected_level$|service_name$)/;
function pickInterestingLabels(l: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(l)) {
    if (!NOISY_LABEL.test(k) || k === 'service_name' || k === 'detected_level') {
      out[k] = v;
    }
  }
  return out;
}

/** Generic table summary (Tempo search results, SQL, anything tabular). */
export function summarizeTable(frames: RawFrame[], maxRows = 30, cellChars = 160): string {
  const parts: string[] = [];
  for (const f of frames) {
    const fields = (f.schema?.fields ?? []).filter((x) => x.type !== 'frame' && x.typeInfo?.frame !== 'json.RawMessage');
    const all = f.schema?.fields ?? [];
    const values = f.data?.values ?? [];
    const n = (values[0] ?? []).length;
    if (!n) {
      continue;
    }
    const cols = fields.map((x) => x.name);
    parts.push(`${f.schema?.name ? f.schema.name + ': ' : ''}${n} rows${n > maxRows ? ` (showing ${maxRows})` : ''}`);
    parts.push(cols.join(' | '));
    for (let j = 0; j < Math.min(n, maxRows); j++) {
      parts.push(
        fields
          .map((fld) => {
            const v = values[all.indexOf(fld)]?.[j];
            if (fld.type === 'time' && typeof v === 'number') {
              return iso(v);
            }
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
            return s.length > cellChars ? s.slice(0, cellChars) + '…' : s;
          })
          .join(' | ')
      );
    }
  }
  return parts.length ? parts.join('\n') : 'No rows returned.';
}

/** Hard cap so a single tool result cannot flood the context window. */
export function clip(text: string, max = 14_000): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars; narrow the query for detail]`;
}
