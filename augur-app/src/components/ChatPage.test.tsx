import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { of, throwError } from 'rxjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const posted: Array<{ url: string; data: any; headers?: any }> = [];
let modelScript: any[] = [];
let appSettings: any = {};
let dashboardJson: any;

const route = (opts: { url: string; method: string; data?: any; params?: any; headers?: any }) => {
  const { url, method, data, headers } = opts;
  if (method === 'POST') {
    posted.push({ url, data, headers });
  }
  if (url.endsWith('/resources/config')) {
    return { defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5'], maxTokens: 8192, authMethod: 'oauth', mcpServers: ['wiki'] };
  }
  if (url.endsWith('/resources/mcp/tools')) {
    return {
      servers: [
        {
          name: 'wiki',
          requireApproval: true,
          tools: [
            { name: 'search', description: 'Search wiki', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
            { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object' } },
          ],
        },
      ],
    };
  }
  if (url.endsWith('/resources/mcp/call')) {
    return { content: [{ type: 'text', text: `wiki ${data.tool} ok` }] };
  }
  if (url.endsWith('/resources/messages')) {
    const next = modelScript.shift();
    if (next instanceof Error) {
      return next;
    }
    if (!next) {
      return { id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '(no more script)' }] };
    }
    return { id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', ...next };
  }
  if (url === '/api/plugins/augur-assistant-app/settings') {
    return { jsonData: appSettings };
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
  if (url.startsWith('/api/dashboards/uid/')) {
    return dashboardJson;
  }
  if (url === '/api/dashboards/db') {
    return { uid: 'new', url: '/d/new/saved', status: 'success', version: 2 };
  }
  if (url === '/api/annotations') {
    return method === 'POST' ? { id: 1 } : [{ time: NOW - 30 * 60000, tags: ['deploy'], text: 'checkout v2.4.0' }];
  }
  if (url.endsWith('/api/v2/alerts')) {
    return [{ labels: { alertname: 'HighErrors', service: 'checkout' } }];
  }
  if (url.endsWith('/api/v2/silences')) {
    return { silenceID: 'sil-1' };
  }
  if (url === '/api/v1/provisioning/alert-rules') {
    return { uid: 'rule-1' };
  }
  return [];
};

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PluginPage: ({ children }: any) => <div>{children}</div>,
  locationService: { push: jest.fn() },
  config: { bootData: { user: { login: 'anirudh', orgRole: 'Editor' } }, buildInfo: { version: '12.2.0' } },
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
import Sidebar from './Sidebar';

function renderPage(path = '/a/augur-assistant-app') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>
  );
}

async function ask(text: string, button = /^Send$/) {
  await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: button }));
}

const modelCalls = () => posted.filter((p) => p.url.endsWith('/resources/messages'));

beforeEach(() => {
  posted.length = 0;
  modelScript = [];
  appSettings = {};
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
});

test('investigation: findings and hypotheses board, conclusion gate, save to Grafana', async () => {
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
      content: [
        { type: 'tool_use', id: 'c', name: 'record_finding', input: { title: 'Errors rose after v2.4.0 deploy', detail: '1% → 20%', severity: 'high' } },
        { type: 'tool_use', id: 'h', name: 'update_hypothesis', input: { key: 'deploy', statement: 'v2.4.0 deploy caused errors', status: 'supported', confidence: 0.8 } },
      ],
    },
    // Model tries to conclude without challenging; the gate pushes back once.
    { content: [{ type: 'text', text: 'Draft conclusion.' }] },
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'h2', name: 'update_hypothesis', input: { key: 'deploy', statement: 'v2.4.0 deploy caused errors', status: 'confirmed', confidence: 0.9, challenged: true } }],
    },
    { content: [{ type: 'text', text: '## Summary\nThe **v2.4.0** deploy caused the error spike.' }] },
  ];
  renderPage('/a/augur-assistant-app?mode=investigate');
  await screen.findByText(/Describe the symptom to investigate/);
  await ask('checkout errors spiked', /Investigate$/);

  await screen.findByText((_c, el) => el?.tagName === 'P' && el.textContent === 'The v2.4.0 deploy caused the error spike.');
  const calls = modelCalls();
  expect(calls).toHaveLength(5);
  expect(JSON.stringify(calls[3].data.messages)).toContain('actively try to falsify the leading hypothesis');
  expect(calls[0].data.system[0].text).toContain('Mode: INVESTIGATION');
  expect(calls[0].data.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['record_finding', 'update_hypothesis', 'delegate', 'mcp__wiki__search']));

  const panel = screen.getByTestId('augur-investigation-panel');
  expect(within(panel).getByText('v2.4.0 deploy caused errors')).toBeInTheDocument();
  expect(within(panel).getByText(/90% · challenged/)).toBeInTheDocument();
  expect(within(panel).getByText('Errors rose after v2.4.0 deploy')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Save to Grafana/ }));
  await screen.findByText(/Saved this investigation to Grafana/);
  const saved = posted.find((p) => p.url === '/api/dashboards/db')!;
  expect(saved.data.dashboard.tags).toContain('augur-investigation');
  expect(saved.data.dashboard.panels[0].options.content).toContain('v2.4.0');
  expect(saved.data.dashboard.panels.some((p: any) => p.targets?.[0]?.expr === 'sum by (service) (rate(errors[5m]))')).toBe(true);
  expect(posted.some((p) => p.url === '/api/annotations' && p.data.dashboardUID === 'new')).toBe(true);
});

test('dashboard draft saves only on click; edit proposal applies with version guard', async () => {
  dashboardJson = {
    dashboard: { uid: 'svc', title: 'Service', version: 7, panels: [{ id: 1, type: 'timeseries', title: 'Old', gridPos: { x: 0, y: 0, w: 12, h: 8 }, targets: [{ refId: 'A', expr: 'up' }] }] },
    meta: { folderUid: 'f1', url: '/d/svc/service', canSave: true },
  };
  modelScript = [
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'd',
          name: 'draft_dashboard',
          input: { title: 'Checkout overview', panels: [{ title: 'Error rate', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'sum(rate(errors[$__rate_interval]))' }] }] },
        },
        {
          type: 'tool_use',
          id: 'e',
          name: 'propose_dashboard_edit',
          input: { dashboard_uid: 'svc', summary: 'add p95', update_panels: [{ panel_id: 1, title: 'Uptime' }], add_panels: [{ title: 'p95', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'histogram_quantile(0.95, x)' }] }] },
        },
      ],
    },
    { content: [{ type: 'text', text: 'Draft and edit ready.' }] },
  ];
  renderPage();
  await ask('build a checkout dashboard and add p95 to the service dashboard');
  const cards = await screen.findAllByTestId(/claude-draft-card|augur-proposal/);
  expect(cards).toHaveLength(2);
  expect(posted.some((p) => p.url === '/api/dashboards/db')).toBe(false);

  const edit = screen.getByTestId('augur-proposal');
  expect(within(edit).getByText(/title "Old" → "Uptime"/)).toBeInTheDocument();
  expect(within(edit).getByText(/\+ add panel "p95"/)).toBeInTheDocument();
  fireEvent.click(within(edit).getByRole('button', { name: /Apply changes/ }));
  await within(edit).findByText(/Open dashboard/);
  const save = posted.find((p) => p.url === '/api/dashboards/db')!;
  expect(save.data).toMatchObject({ overwrite: false, folderUid: 'f1' });
  expect(save.data.dashboard.version).toBe(7);
  expect(save.data.dashboard.panels).toHaveLength(2);
});

test('silence and alert rule proposals are created only by the user', async () => {
  modelScript = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 's', name: 'draft_silence', input: { matchers: [{ name: 'service', value: 'checkout' }], duration: '2h', comment: 'deploy rollback in progress' } },
        {
          type: 'tool_use',
          id: 'r',
          name: 'draft_alert_rule',
          input: { title: 'Checkout 5xx', folder_uid: 'f1', group: 'checkout', datasource_uid: 'mimir', expr: 'sum(rate(errors[5m]))', operator: 'gt', threshold: 0.05, for: '5m', labels: { severity: 'page' } },
        },
      ],
    },
    { content: [{ type: 'text', text: 'Proposals ready.' }] },
  ];
  renderPage();
  await ask('silence checkout and add an alert');
  await screen.findByText('Proposals ready.');
  const cards = screen.getAllByTestId('augur-proposal');
  expect(within(cards[0]).getByText(/1 firing alerts match/)).toBeInTheDocument();
  expect(posted.some((p) => p.url.endsWith('/silences') || p.url.includes('provisioning'))).toBe(false);

  fireEvent.click(within(cards[0]).getByRole('button', { name: /Create silence/ }));
  await within(cards[0]).findByText(/View silences/);
  const sil = posted.find((p) => p.url.endsWith('/api/v2/silences'))!;
  expect(sil.data.matchers).toEqual([{ name: 'service', value: 'checkout', isRegex: false, isEqual: true }]);
  expect(sil.data.createdBy).toBe('anirudh');

  fireEvent.click(within(cards[1]).getByRole('button', { name: /Create alert rule/ }));
  await within(cards[1]).findByText(/Open alert rule/);
  const rule = posted.find((p) => p.url === '/api/v1/provisioning/alert-rules')!;
  expect(rule.headers).toEqual({ 'X-Disable-Provenance': 'true' });
  expect(rule.data).toMatchObject({ title: 'Checkout 5xx', ruleGroup: 'checkout', folderUID: 'f1', condition: 'C', for: '5m' });
  expect(rule.data.data[2].model.conditions[0].evaluator).toEqual({ type: 'gt', params: [0.05] });
});

test('MCP: read-only tools run directly, others need approval; skills and rules reach the prompt', async () => {
  appSettings = {
    rules: [{ id: '1', text: 'Prod metrics are in Mimir.', scope: 'all', enabled: true }],
    skills: [{ name: 'kafka-lag', title: 'Kafka lag', description: 'Consumer lag runbook', body: 'Check consumer group lag first.', enabled: true }],
  };
  modelScript = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'm1', name: 'mcp__wiki__search', input: { q: 'kafka' } },
        { type: 'tool_use', id: 'm2', name: 'mcp__wiki__create_page', input: { title: 'x' } },
      ],
    },
    { content: [{ type: 'text', text: 'Done with wiki.' }] },
  ];
  renderPage();
  await waitFor(() => expect(posted.length + 1).toBeGreaterThan(0));
  await ask('/kafka-lag orders topic');
  const approval = await screen.findByTestId('augur-approval');
  expect(within(approval).getByText(/Allow wiki → create_page/)).toBeInTheDocument();
  expect(posted.filter((p) => p.url.endsWith('/mcp/call')).map((p) => p.data.tool)).toEqual(['search']);
  fireEvent.click(within(approval).getByRole('button', { name: /Allow once/ }));
  await screen.findByText('Done with wiki.');
  expect(posted.filter((p) => p.url.endsWith('/mcp/call')).map((p) => p.data.tool)).toEqual(['search', 'create_page']);

  const first = modelCalls()[0].data;
  expect(first.system[0].text).toContain('Prod metrics are in Mimir.');
  expect(first.system[0].text).toContain('kafka-lag: Consumer lag runbook');
  expect(JSON.stringify(first.messages[0])).toContain('Check consumer group lag first.');
  expect(JSON.stringify(first.messages[0])).toContain('with: orders topic');
});

test('history: conversations persist and can be reopened', async () => {
  modelScript = [{ content: [{ type: 'text', text: 'First answer.' }] }];
  const { unmount } = renderPage();
  await ask('first question');
  await screen.findByText('First answer.');
  unmount();
  renderPage();
  expect(await screen.findByText('First answer.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  expect(screen.queryByText('First answer.')).not.toBeInTheDocument();
});

test('sidebar includes the current page as context and auto-starts from entry points', async () => {
  window.history.pushState({}, '', '/d/abc123/svc?from=now-6h&to=now&var-namespace=prod');
  modelScript = [{ content: [{ type: 'text', text: 'This dashboard shows checkout.' }] }];
  render(
    <MemoryRouter>
      <Sidebar q="Explain this panel" mode="chat" context="Panel: RPS" />
    </MemoryRouter>
  );
  await screen.findByText('This dashboard shows checkout.');
  const first = modelCalls()[0].data;
  expect(first.system[0].text).toContain('Dashboard uid abc123');
  expect(first.system[0].text).toContain('namespace=prod');
  expect(JSON.stringify(first.messages[0])).toContain('Panel: RPS');
});

test('shows gateway auth errors clearly', async () => {
  modelScript = [new Error('no OAuth token was forwarded by Grafana')];
  renderPage();
  await ask('hi');
  await screen.findByText(/HTTP 401: no OAuth token was forwarded/);
});

test('opening from a panel link auto-starts with the panel context', async () => {
  modelScript = [{ content: [{ type: 'text', text: 'This panel shows request rate.' }] }];
  const ctx = 'Dashboard: "API" (uid d1)\nPanel: "RPS" (id 2, type timeseries)';
  await act(async () => {
    renderPage(`/a/augur-assistant-app?mode=chat&q=${encodeURIComponent('Explain this panel')}&context=${encodeURIComponent(ctx)}`);
  });
  await screen.findByText('This panel shows request rate.');
  expect(JSON.stringify(modelCalls()[0].data.messages[0])).toContain('Panel: \\"RPS\\"');
});
