import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { of } from 'rxjs';
import { previewModel, panelQueryBody, resolveDatasource } from './draftPreviewModel';

const posted: Array<{ url: string; data: any }> = [];
const rendered: any[] = [];

jest.mock('react-use', () => ({ ...jest.requireActual('react-use'), useMeasure: () => [() => undefined, { width: 480, height: 0 }] }));
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelRenderer: (p: any) => {
    rendered.push(p);
    return <div data-testid="panel-renderer">{`${p.pluginId}:${p.title}:${p.data?.series?.length ?? 0}`}</div>;
  },
  getDataSourceSrv: () => ({
    getList: () => [
      { uid: 'mimir', name: 'Mimir', type: 'prometheus', isDefault: true },
      { uid: 'loki', name: 'Loki', type: 'loki', isDefault: false },
    ],
  }),
  getBackendSrv: () => ({
    fetch: (opts: any) => {
      posted.push({ url: opts.url, data: opts.data });
      if (opts.url === '/api/ds/query') {
        const refId = opts.data.queries[0].refId;
        return of({
          data: {
            results: {
              [refId]: {
                frames: [{ schema: { fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number' }] }, data: { values: [[1, 2], [3, 4]] } }],
              },
            },
          },
        });
      }
      if (opts.url === '/api/dashboards/db') {
        return of({ data: { url: `/d/${opts.data.dashboard.uid ?? 'gen'}/svc` } });
      }
      return of({ data: [] });
    },
  }),
}));

import { DraftCard } from './DraftCard';

const json = {
  uid: 'u1',
  title: 'Svc',
  templating: { list: [{ name: 'ds', type: 'datasource', query: 'prometheus' }, { name: 'ns', type: 'query' }] },
  panels: [
    { id: 1, type: 'stat', title: 'RPS', gridPos: { x: 0, y: 0, w: 12, h: 4 }, datasource: { uid: '${ds}', type: 'prometheus' }, targets: [{ refId: 'A', expr: 'sum(rate(x_total{ns="$ns"}[$__rate_interval]))' }] },
    { id: 2, type: 'text', title: 'Notes', gridPos: { x: 12, y: 0, w: 12, h: 4 }, options: { content: 'hi' } },
    { id: 3, type: 'row', title: 'Details', collapsed: true, gridPos: { x: 0, y: 4, w: 24, h: 1 }, panels: [{ id: 4, type: 'table', title: 'Hidden' }] },
  ],
};

const draft = (over: any = {}) => ({ id: 'd1', title: 'Svc', json, outline: ['RPS — stat'], warnings: [], checks: [], createdAt: 0, revision: 1, lineage: 'd1', ...over });

beforeEach(() => {
  posted.length = 0;
  rendered.length = 0;
  localStorage.clear();
});

describe('preview model', () => {
  it('draws rows as headers, hides collapsed panels and caps the panel count', () => {
    const m = previewModel(json);
    expect(m.cells.map((c) => (c.kind === 'row' ? `row:${c.title}:${c.hidden}` : c.panel.title))).toEqual(['RPS', 'Notes', 'row:Details:1']);
    expect(m.height).toBe(5);
    const big = { panels: Array.from({ length: 25 }, (_, i) => ({ type: 'stat', title: `p${i}`, gridPos: { x: 0, y: i, w: 6, h: 1 } })) };
    expect(previewModel(big).omitted).toBe(5);
  });

  it('resolves datasource variables and wildcards dashboard variables in queries', () => {
    const list = [{ uid: 'mimir', type: 'prometheus', isDefault: true }];
    expect(resolveDatasource({ uid: '${ds}', type: 'prometheus' }, json.templating.list, list)).toEqual({ uid: 'mimir', type: 'prometheus' });
    expect(resolveDatasource({ uid: '$nope', type: 'x' }, [], list)).toBeUndefined();
    const body = panelQueryBody(json.panels[0], json.templating.list, list, 240)!;
    expect(body.queries[0]).toMatchObject({ refId: 'A', datasource: { uid: 'mimir' }, expr: 'sum(rate(x_total{ns=~".+"}[$__rate_interval]))', maxDataPoints: 240 });
    expect(panelQueryBody(json.panels[1], [], list, 240)).toBeUndefined();
  });
});

describe('DraftCard', () => {
  it('renders real panels with queried data', async () => {
    render(<DraftCard draft={draft() as any} superseded={false} onSaved={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('panel-renderer')).toHaveLength(2));
    expect(screen.getByText('stat:RPS:1')).toBeInTheDocument();
    expect(screen.getByText('text:Notes:0')).toBeInTheDocument();
    expect(screen.getByText(/1 panels, collapsed/)).toBeInTheDocument();
    expect(posted.filter((p) => p.url === '/api/ds/query')).toHaveLength(1); // text panels aren't queried
    fireEvent.click(screen.getByRole('button', { name: /Outline/ }));
    expect(screen.queryByTestId('augur-draft-preview')).not.toBeInTheDocument();
    expect(screen.getByText('RPS — stat')).toBeInTheDocument();
  });

  it('does not query superseded drafts', () => {
    render(<DraftCard draft={draft() as any} superseded={true} onSaved={jest.fn()} />);
    expect(screen.queryByTestId('augur-draft-preview')).not.toBeInTheDocument();
    expect(posted.some((p) => p.url === '/api/ds/query')).toBe(false);
  });

  it('a later revision updates the dashboard saved from an earlier one, or saves a new copy', async () => {
    const onSaved = jest.fn();
    const first = render(<DraftCard draft={draft() as any} superseded={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Save as new dashboard/ }));
    await screen.findByText(/Open saved dashboard/);
    expect(onSaved).toHaveBeenLastCalledWith('Saved dashboard "Svc"', '/d/u1/svc');
    first.unmount();

    const card = render(<DraftCard draft={draft({ id: 'd2', revision: 2, fixes: ['panel "RPS": unit reqps inferred'] }) as any} superseded={false} onSaved={onSaved} />);
    expect(screen.getByText(/revision 2/)).toBeInTheDocument();
    expect(screen.getByText('1 automatic fixes')).toBeInTheDocument();
    posted.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /Update saved dashboard/ }));
    await screen.findByText(/Open saved dashboard/);
    const save = posted.find((p) => p.url === '/api/dashboards/db')!;
    expect(save.data).toMatchObject({ overwrite: true, dashboard: { uid: 'u1' } });
    expect(onSaved).toHaveBeenLastCalledWith('Updated dashboard "Svc" (revision 2)', '/d/u1/svc');
    card.unmount();

    // After a reload the saved revision shows "Open"; a third revision can still be saved as a new copy.
    render(<DraftCard draft={draft({ id: 'd2', revision: 2 }) as any} superseded={false} onSaved={onSaved} />);
    expect(screen.getByRole('link', { name: /Open saved dashboard/ })).toBeInTheDocument();
  });

  it('save as new keeps the earlier dashboard', async () => {
    localStorage.setItem('augur-assistant-app/saved-drafts', JSON.stringify({ d1: { uid: 'old', url: '/d/old/svc', revision: 1, at: 1 } }));
    render(<DraftCard draft={draft({ id: 'd3', revision: 3, json: { ...json, uid: 'fresh' } }) as any} superseded={false} onSaved={jest.fn()} />);
    const actions = screen.getByTestId('claude-draft-card');
    fireEvent.click(within(actions).getByRole('button', { name: /^Save as new$/ }));
    await screen.findByText(/Open saved dashboard/);
    const save = posted.find((p) => p.url === '/api/dashboards/db')!;
    expect(save.data.overwrite).not.toBe(true);
    expect(save.data.dashboard.uid).toBe('fresh');
  });
});
