import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { useMeasure } from 'react-use';
import { dateTime, GrafanaTheme2, LoadingState, PanelData } from '@grafana/data';
import { getDataSourceSrv, PanelRenderer, toDataQueryResponse } from '@grafana/runtime';
import { ErrorBoundaryAlert, Icon, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { grafanaHttp } from '../api';
import { errorMessage } from '../agent/grafana';
import { panelQueryBody, previewModel } from './draftPreviewModel';

/** Height of one grid unit in the preview (Grafana uses 30px; the chat column is narrower). */
const UNIT = 22;
const GAP = 4;
const PARALLEL = 4;

type PanelState = { state: 'loading' } | { state: 'done'; data: PanelData } | { state: 'error'; message: string };

/** Renders a dashboard draft with real panels and real data (last hour, variables set to all values). */
export function DraftPreview({ json }: { json: Record<string, any> }) {
  const s = useStyles2(getStyles);
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const model = useMemo(() => previewModel(json), [json]);
  const [results, setResults] = useState<Record<number, PanelState>>({});
  const colW = width / 24;
  const measured = width > 0;

  // Query once the width is known (it sets maxDataPoints); don't re-query on resize.
  useEffect(() => {
    if (!measured) {
      return;
    }
    const abort = new AbortController();
    const templating = (json.templating?.list ?? []) as Array<Record<string, any>>;
    const list = getDataSourceSrv()
      .getList({})
      .map((d) => ({ uid: d.uid, type: d.type, name: d.name, isDefault: d.isDefault }));
    const to = dateTime();
    const from = dateTime(to).subtract(1, 'hour');
    const timeRange = { from, to, raw: { from: 'now-1h', to: 'now' } };
    const jobs = model.cells.flatMap((c, idx) => {
      if (c.kind !== 'panel') {
        return [];
      }
      const body = panelQueryBody(c.panel, templating, list, (c.pos.w / 24) * width);
      return [{ idx, body }];
    });
    const run = async (j: (typeof jobs)[number]) => {
      let next: PanelState;
      if (!j.body) {
        next = { state: 'done', data: { state: LoadingState.Done, series: [], timeRange } };
      } else {
        try {
          const raw = await grafanaHttp.post<any>('/api/ds/query', j.body, abort.signal);
          const res = toDataQueryResponse({ data: raw } as any);
          next = { state: 'done', data: { state: LoadingState.Done, series: res.data ?? [], timeRange, errors: res.errors } };
        } catch (e) {
          next = { state: 'error', message: errorMessage(e) };
        }
      }
      if (!abort.signal.aborted) {
        setResults((r) => ({ ...r, [j.idx]: next }));
      }
    };
    const queue = [...jobs];
    const worker = async () => {
      for (let j = queue.shift(); j && !abort.signal.aborted; j = queue.shift()) {
        await run(j);
      }
    };
    void Promise.all(Array.from({ length: PARALLEL }, worker));
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, measured]);

  return (
    <div ref={ref} className={s.wrap} data-testid="augur-draft-preview">
      {measured && (
        <div className={s.grid} style={{ height: model.height * UNIT }}>
          {model.cells.map((c, idx) => {
            const left = c.pos.x * colW;
            const top = c.pos.y * UNIT;
            const w = c.pos.w * colW - GAP;
            const h = c.pos.h * UNIT - GAP;
            if (c.kind === 'row') {
              return (
                <div key={idx} className={s.row} style={{ left, top, width: w, height: h }}>
                  <Icon name={c.collapsed ? 'angle-right' : 'angle-down'} />
                  {c.title}
                  {c.collapsed && c.hidden > 0 && <span className={s.muted}>({c.hidden} panels, collapsed)</span>}
                </div>
              );
            }
            const st = results[idx];
            return (
              <div key={idx} className={s.cell} style={{ left, top, width: w, height: h }} aria-label={`Preview of ${c.panel.title ?? 'panel'}`}>
                {!st || st.state === 'loading' ? (
                  <div className={s.center}>
                    <LoadingPlaceholder text={c.panel.title ?? ''} />
                  </div>
                ) : st.state === 'error' ? (
                  <div className={s.center} title={st.message}>
                    <Icon name="exclamation-triangle" /> {c.panel.title}: {st.message.slice(0, 120)}
                  </div>
                ) : (
                  <ErrorBoundaryAlert style="alertbox">
                    <PanelRenderer
                      title={c.panel.title ?? ''}
                      pluginId={c.panel.type}
                      width={w}
                      height={h}
                      data={st.data}
                      options={c.panel.options ?? {}}
                      fieldConfig={c.panel.fieldConfig ?? { defaults: {}, overrides: [] }}
                      timeZone="browser"
                    />
                  </ErrorBoundaryAlert>
                )}
              </div>
            );
          })}
        </div>
      )}
      {model.omitted > 0 && <div className={s.muted}>{model.omitted} more panels not previewed; open the saved dashboard to see them.</div>}
    </div>
  );
}

const getStyles = (t: GrafanaTheme2) => ({
  wrap: css({ width: '100%' }),
  grid: css({ position: 'relative', width: '100%' }),
  cell: css({
    position: 'absolute',
    background: t.colors.background.primary,
    border: `1px solid ${t.colors.border.weak}`,
    borderRadius: t.shape.radius.default,
    overflow: 'hidden',
  }),
  row: css({
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: t.spacing(0.5),
    fontWeight: t.typography.fontWeightMedium,
    fontSize: t.typography.bodySmall.fontSize,
  }),
  center: css({
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing(0.5),
    padding: t.spacing(1),
    fontSize: t.typography.bodySmall.fontSize,
    color: t.colors.text.secondary,
    textAlign: 'center',
  }),
  muted: css({ color: t.colors.text.secondary, fontSize: t.typography.bodySmall.fontSize, fontWeight: 'normal' }),
});
