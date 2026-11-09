import { TimeRangeMs } from './types';

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses a time expression into epoch ms.
 * Accepts: "now", "now-1h", "now-30m+5m", epoch seconds/ms (number or numeric string), RFC3339/ISO strings.
 */
export function parseTime(value: unknown, now: number): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  if (s.startsWith('now')) {
    let t = now;
    const re = /([+-])(\d+)([smhdw])/g;
    const rest = s.slice(3);
    let consumed = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      const delta = Number(m[2]) * UNIT_MS[m[3]];
      t = m[1] === '-' ? t - delta : t + delta;
      consumed += m[0].length;
    }
    if (consumed !== rest.length) {
      throw new Error(`unsupported relative time "${s}" (use forms like now-1h, now-30m, now-2d)`);
    }
    return t;
  }
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) {
    throw new Error(`could not parse time "${s}"`);
  }
  return parsed;
}

/** Resolves start/end inputs against a default range. */
export function resolveRange(input: { start?: unknown; end?: unknown }, fallback: TimeRangeMs, now: number): TimeRangeMs {
  const from = parseTime(input.start, now) ?? fallback.from;
  const to = parseTime(input.end, now) ?? fallback.to;
  if (from >= to) {
    throw new Error(`start (${new Date(from).toISOString()}) must be before end (${new Date(to).toISOString()})`);
  }
  return { from, to };
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** Picks a Prometheus step giving roughly `points` samples, rounded to a sane unit. */
export function autoStepSeconds(range: TimeRangeMs, points = 120): number {
  const raw = Math.max(15, Math.ceil((range.to - range.from) / 1000 / points));
  const nice = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];
  return nice.find((n) => n >= raw) ?? raw;
}

export function parseDurationSeconds(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  if (typeof v === 'number') {
    return v;
  }
  const m = /^(\d+)([smhd])?$/.exec(String(v).trim());
  if (!m) {
    throw new Error(`invalid step "${v}" (use e.g. 30s, 1m, 5m)`);
  }
  return Number(m[1]) * ((m[2] ? UNIT_MS[m[2]] : 1000) / 1000);
}
