import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { of, throwError } from 'rxjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const posted: Array<{ url: string; data: any }> = [];
let modelScript: any[] = [];

const route = (opts: { url: string; method: string; data?: any; params?: any }) => {
  const { url, method, data } = opts;
  if (method === 'POST') {
    posted.push({ url, data });
  }
  if (url.endsWith('/resources/config')) {
    return { defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5'], maxTokens: 8192, authMethod: 'oauth' };
  }
  if (url.endsWith('/resources/messages')) {
    const next = modelScript.shift();
    if (next instanceof Error) {
      return next;
    }
    return { id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', ...next };
  }
  if (url === '/api/ds/query') {
    return {
      results: {
        A: {
          frames: [
            {
              schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { service: 'checkout' } }] },
              data: { values: [[NOW - 60000, NOW], [0.01, 0.2]] },
            },
          ],
        },
      },
    };
  }
  if (url === '/api/search') {
    return [{ uid: 'f1', title: 'Platform' }];
  }
  if (url === '/api/dashboards/db') {
    return { uid: 'new', url: '/d/new/checkout', status: 'success', version: 1 };
  }
  if (url === '/api/annotations') {
    return [{ time: NOW - 30 * 60000, tags: ['deploy'], text: 'checkout v2.4.0' }];
  }
  return [];
};

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PluginPage: ({ children, actions }: any) => (
    <div>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  ),
  config: { bootData: { user: { login: 'anirudh', orgRole: 'Editor' } }, buildInfo: { version: '13.2.0' } },
  getBackendSrv: () => ({
    fetch: (opts: any) => {
      const r = route(opts);
      return r instanceof Error ? throwError(() => ({ status: 401, data: { error: { message: r.message } } })) : of({ data: r });
    },
  }),
  getDataSourceSrv: () => ({
    getList: (f: any) => {
      const all = [
        { uid: 'claude', name: 'Claude', type: 'augur-claude-datasource', isDefault: false },
        { uid: 'mimir', name: 'Mimir', type: 'prometheus', isDefault: true },
        { uid: 'loki', name: 'Loki', type: 'loki', isDefault: false },
      ];
      return f?.type ? all.filter((d) => d.type === f.type) : all;
    },
  }),
}));

import { ChatPage } from './ChatPage';

function renderPage(path = '/a/augur-assistant-app') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  posted.length = 0;
  modelScript = [];
  sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
});

test('investigation: tools run, findings appear in sidebar, report is exportable', async () => {
  modelScript = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Checking error rate and recent deploys.' },
        { type: 'tool_use', id: 'a', name: 'query_prometheus', input: { datasource_uid: 'mimir', expr: 'sum by (service) (rate(errors[5m]))' } },
        { type: 'tool_use', id: 'b', name: 'get_annotations', input: { tags: ['deploy'] } },
      ],
    },
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'c', name: 'record_finding', input: { title: 'Errors rose after v2.4.0 deploy', detail: '1% → 20%', severity: 'high', evidence: 'rate(errors[5m])' } }],
    },
    { content: [{ type: 'text', text: '## Summary\nThe **v2.4.0** deploy caused the error spike.' }] },
  ];
  renderPage('/a/augur-assistant-app?mode=investigate');
  await screen.findByText(/Describe the symptom to investigate/);
  await waitFor(() => expect(screen.getByRole('button', { name: /Investigate$/ })).toBeInTheDocument());

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'checkout errors spiked' } });
  fireEvent.click(screen.getByRole('button', { name: /Investigate$/ }));

  await screen.findByText((_c, el) => el?.tagName === 'P' && el.textContent === 'The v2.4.0 deploy caused the error spike.');
  expect(screen.getByText(/PromQL: sum by \(service\)/)).toBeInTheDocument();
  expect(screen.getAllByText('Errors rose after v2.4.0 deploy').length).toBeGreaterThanOrEqual(2); // timeline + sidebar

  // Model calls went through the Claude datasource with system prompt + tools; user text prefixed for investigation
  const modelCalls = posted.filter((p) => p.url.endsWith('/resources/messages'));
  expect(modelCalls).toHaveLength(3);
  expect(modelCalls[0].data.model).toBe('claude-sonnet-5-5');
  expect(modelCalls[0].data.system[0].text).toContain('Mode: INVESTIGATION');
  expect(modelCalls[0].data.tools.map((t: any) => t.name)).toContain('record_finding');
  expect(JSON.stringify(modelCalls[0].data.messages)).toContain('Investigate: checkout errors spiked');
  // Data queries went to Grafana's query API (as the user), not through Claude
  expect(posted.some((p) => p.url === '/api/ds/query' && p.data.queries[0].datasource.uid === 'mimir')).toBe(true);
  expect(screen.getByRole('button', { name: /Export report/ })).toBeInTheDocument();
  expect(screen.getByText(/via your identity/)).toBeInTheDocument();
});

test('dashboard building: draft card renders and saves as new dashboard on click only', async () => {
  modelScript = [
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'd',
          name: 'draft_dashboard',
          input: {
            title: 'Checkout overview',
            panels: [
              { title: 'Error rate', type: 'timeseries', datasource_uid: 'mimir', unit: 'percentunit', queries: [{ expr: 'sum(rate(errors[$__rate_interval]))' }] },
              { title: 'Error logs', type: 'logs', datasource_uid: 'loki', queries: [{ expr: '{app="checkout"} |= "error"' }] },
            ],
          },
        },
      ],
    },
    { content: [{ type: 'text', text: 'Your dashboard draft is ready to review.' }] },
  ];
  renderPage();
  await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'build a checkout dashboard' } });
  fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));

  const card = await screen.findByTestId('claude-draft-card');
  expect(within(card).getByText('Checkout overview')).toBeInTheDocument();
  expect(within(card).getByText(/2\/2 queries returned data/)).toBeInTheDocument();
  expect(posted.some((p) => p.url === '/api/dashboards/db')).toBe(false); // nothing saved yet

  fireEvent.click(within(card).getByRole('button', { name: /Save as new dashboard/ }));
  await within(card).findByText(/Open saved dashboard/);
  const save = posted.find((p) => p.url === '/api/dashboards/db')!;
  expect(save.data.overwrite).toBe(false);
  expect(save.data.dashboard.panels).toHaveLength(2);
  expect(screen.getByText(/Saved "Checkout overview"/)).toBeInTheDocument();
});

test('shows gateway auth errors clearly', async () => {
  modelScript = [new Error('no OAuth token was forwarded by Grafana')];
  renderPage();
  await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
  fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
  await screen.findByText(/HTTP 401: no OAuth token was forwarded/);
});

test('opening from a panel link auto-starts with the panel context', async () => {
  modelScript = [{ content: [{ type: 'text', text: 'This panel shows request rate.' }] }];
  const ctx = 'Dashboard: "API" (uid d1)\nPanel: "RPS" (id 2, type timeseries)';
  renderPage(`/a/augur-assistant-app?mode=chat&q=${encodeURIComponent('Explain this panel')}&context=${encodeURIComponent(ctx)}`);
  await screen.findByText('This panel shows request rate.');
  const first = posted.find((p) => p.url.endsWith('/resources/messages'))!;
  expect(JSON.stringify(first.data.messages[0])).toContain('Panel: \\"RPS\\"');
});
