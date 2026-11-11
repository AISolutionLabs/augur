// Pure helpers for the dashboard draft preview: which cells to draw where, and what to query.
import { wildcardVars } from '../agent/dashboard';

export const PREVIEW_MAX_PANELS = 20;

export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PreviewCell =
  | { kind: 'row'; title: string; collapsed: boolean; hidden: number; pos: GridPos }
  | { kind: 'panel'; panel: Record<string, any>; pos: GridPos };

export interface PreviewModel {
  cells: PreviewCell[];
  /** Height of the whole grid, in grid units. */
  height: number;
  /** Panels not drawn because of the cap. */
  omitted: number;
}

/**
 * Lays the dashboard out the way Grafana would: rows become headers, panels inside a collapsed
 * row are not drawn (and the rows below move up, as they do in Grafana), and at most `max` panels
 * are drawn so a big draft doesn't fire dozens of queries from the chat.
 */
export function previewModel(json: Record<string, any>, max = PREVIEW_MAX_PANELS): PreviewModel {
  const cells: PreviewCell[] = [];
  let drawn = 0;
  let omitted = 0;
  let height = 0;
  for (const p of (json.panels ?? []) as Array<Record<string, any>>) {
    const pos: GridPos = { x: 0, y: 0, w: 24, h: 8, ...(p.gridPos ?? {}) };
    if (p.type === 'row') {
      const hidden = Array.isArray(p.panels) ? p.panels.length : 0;
      cells.push({ kind: 'row', title: p.title ?? '', collapsed: !!p.collapsed, hidden, pos: { ...pos, x: 0, w: 24, h: 1 } });
      height = Math.max(height, pos.y + 1);
      continue;
    }
    if (drawn >= max) {
      omitted++;
      continue;
    }
    drawn++;
    cells.push({ kind: 'panel', panel: p, pos });
    height = Math.max(height, pos.y + pos.h);
  }
  return { cells, height, omitted };
}

export interface DsRef {
  uid: string;
  type: string;
}

/** Resolve a panel or target datasource, following `${var}` references to datasource variables. */
export function resolveDatasource(
  ref: DsRef | string | undefined,
  templating: Array<Record<string, any>>,
  list: Array<{ uid: string; type: string; isDefault?: boolean }>
): DsRef | undefined {
  if (!ref) {
    return undefined;
  }
  const uid = typeof ref === 'string' ? ref : ref.uid;
  const m = /^\$\{?(\w+)\}?$/.exec(uid ?? '');
  if (!m) {
    const hit = list.find((d) => d.uid === uid);
    return hit ? { uid: hit.uid, type: hit.type } : typeof ref === 'string' ? undefined : ref;
  }
  const v = templating.find((t) => t.name === m[1] && t.type === 'datasource');
  if (!v) {
    return undefined;
  }
  const current = v.current?.value;
  const byCurrent = list.find((d) => d.uid === current || (d as { name?: string }).name === current);
  if (byCurrent) {
    return { uid: byCurrent.uid, type: byCurrent.type };
  }
  const ofType = list.filter((d) => d.type === v.query);
  const pick = ofType.find((d) => d.isDefault) ?? ofType[0];
  return pick ? { uid: pick.uid, type: pick.type } : undefined;
}

/**
 * The /api/ds/query body for one panel, with dashboard variables wildcarded (the same rule the
 * dry-run uses) so the preview shows what the dashboard would show with "All" selected.
 * Returns undefined for panels with nothing to query (text panels, unresolvable datasources).
 */
export function panelQueryBody(
  panel: Record<string, any>,
  templating: Array<Record<string, any>>,
  list: Array<{ uid: string; type: string; isDefault?: boolean }>,
  widthPx: number
): Record<string, any> | undefined {
  const targets = (panel.targets ?? []) as Array<Record<string, any>>;
  if (!targets.length) {
    return undefined;
  }
  const panelDs = resolveDatasource(panel.datasource, templating, list);
  const maxDataPoints = Math.max(30, Math.min(500, Math.round(widthPx)));
  const queries = targets
    .filter((t) => !t.hide)
    .map((t, i) => {
      const ds = resolveDatasource(t.datasource, templating, list) ?? panelDs;
      if (!ds) {
        return undefined;
      }
      const q: Record<string, any> = { ...t, refId: t.refId ?? String.fromCharCode(65 + i), datasource: ds, maxDataPoints, intervalMs: 60_000 };
      for (const k of ['expr', 'query', 'labelSelector']) {
        if (typeof q[k] === 'string') {
          q[k] = wildcardVars(q[k]);
        }
      }
      return q;
    })
    .filter((q): q is Record<string, any> => !!q);
  return queries.length ? { queries, from: 'now-1h', to: 'now' } : undefined;
}
