import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { from, of, throwError } from 'rxjs';

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
            { name: 'search', description: 'Search wiki', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, augurReadOnly: true },
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
    if (next instanceof Promise) {
      return next.then((v: any) => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', ...v }));
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
      if (r instanceof Promise) {
        return from(r.then((data) => ({ data })));
      }
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
import { resetStoreForTests } from '../session/store';

function renderPage(path = '/a/augur-assistant-app') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatPage />
    </MemoryRouter>
  );
}

async function ask(text: string, button = /^Send$/) {
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Augur' })).not.toBeDisabled());
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Augur' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: button }));
}

const modelCalls = () => posted.filter((p) => p.url.endsWith('/resources/messages'));

beforeEach(() => {
  posted.length = 0;
  modelScript = [];
  appSettings = {};
  localStorage.clear();
  sessionStorage.clear();
  resetStoreForTests();
  Element.prototype.scrollIntoView = jest.fn();
});

test('a run keeps going when the sidebar closes and shows up on the app page', async () => {
  let release: (v: any) => void = () => undefined;
  modelScript = [new Promise((r) => (release = r))];
  const sidebar = render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  );
  await ask('slow question');
  await waitFor(() => expect(modelCalls()).toHaveLength(1));
  sidebar.unmount(); // user closes the sidebar / navigates away
  await act(async () => release({ content: [{ type: 'text', text: 'Finished while the sidebar was closed.' }] }));
  renderPage();
  expect(await screen.findByText('Finished while the sidebar was closed.')).toBeInTheDocument();
});

test('an interrupted run can be resumed from its checkpoint after a reload', async () => {
  const now = Date.now();
  const interrupted = {
    id: 's-int',
    title: 'latency',
    mode: 'investigate',
    rangeKey: '1h',
    createdAt: now - 60_000,
    updatedAt: now - 1_000,
    items: [
      { kind: 'user', text: 'latency spiked', mode: 'investigate' },
      { kind: 'tool', id: 't1', name: 'query_prometheus', label: 'PromQL: up', input: {}, status: 'running' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Investigate: latency spiked' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'query_prometheus', input: { datasource_uid: 'mimir', expr: 'up' } }] },
    ],
    proposals: {},
    findings: [],
    hypotheses: [{ id: 'h', statement: 'db', status: 'confirmed', confidence: 0.9, challenged: true, updatedAt: now }],
    run: { status: 'running', mode: 'investigate', startedAt: now - 60_000 },
  };
  localStorage.setItem('augur-assistant-app/history', JSON.stringify([interrupted]));
  localStorage.setItem('augur-assistant-app/current', 's-int');
  resetStoreForTests();
  modelScript = [{ content: [{ type: 'text', text: 'Resumed and concluded.' }] }];
  renderPage();
  const banner = await screen.findByTestId('augur-interrupted');
  await waitFor(() => expect(within(banner).getByRole('button', { name: 'Resume' })).not.toBeDisabled());
  fireEvent.click(within(banner).getByRole('button', { name: 'Resume' }));
  await screen.findByText('Resumed and concluded.');
  const msgs = modelCalls()[0].data.messages;
  const last = msgs[msgs.length - 1];
  expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
  expect(JSON.stringify(last)).toContain('has now been resumed');
  expect(screen.queryByTestId('augur-interrupted')).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('augur-assistant-app/history')!)[0].run).toBeUndefined();
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
  // PDF export prints a standalone report (with hypotheses and the evidence ledger) from a hidden frame.
  fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
  const frame = document.querySelector('iframe[title="Report print preview"]') as HTMLIFrameElement;
  expect(frame.srcdoc).toContain('v2.4.0 deploy caused errors');
  expect(frame.srcdoc).toContain('hyp-confirmed');
  expect(frame.srcdoc).toContain('Evidence ledger');
  expect(screen.getByRole('button', { name: /Markdown/ })).toBeInTheDocument();
  frame.remove();
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
  await waitFor(() => expect(screen.getAllByTestId(/claude-draft-card|augur-proposal/)).toHaveLength(2));
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
  expect(within(cards[0]).getByText(/1 firing alert matches/)).toBeInTheDocument();
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

describe('run lease across tabs', () => {
  const runningSession = (now: number) => ({
    id: 's-tab',
    title: 'shared',
    mode: 'investigate',
    rangeKey: '1h',
    createdAt: now - 60_000,
    updatedAt: now - 1_000,
    items: [{ kind: 'user', text: 'why slow', mode: 'investigate' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Investigate: why slow' }] }],
    proposals: {},
    findings: [],
    hypotheses: [],
    run: { status: 'running', mode: 'investigate', startedAt: now - 60_000 },
  });

  test('a second tab follows a live run instead of offering Resume, then takes over when it finishes', async () => {
    const now = Date.now();
    localStorage.setItem('augur-assistant-app/history', JSON.stringify([runningSession(now)]));
    localStorage.setItem('augur-assistant-app/current', 's-tab');
    localStorage.setItem('augur-assistant-app/lease/s-tab', JSON.stringify({ sessionId: 's-tab', tabId: 'other-tab', heartbeat: now }));
    resetStoreForTests();
    renderPage();
    await screen.findByTestId('augur-elsewhere');
    expect(screen.queryByTestId('augur-interrupted')).not.toBeInTheDocument();

    // The other tab finishes: it clears the run, saves its answer and releases the lease.
    const done = { ...runningSession(now), run: undefined, items: [...runningSession(now).items, { kind: 'assistant', text: 'Answer from the other tab.' }] };
    localStorage.setItem('augur-assistant-app/history', JSON.stringify([done]));
    localStorage.removeItem('augur-assistant-app/lease/s-tab');
    expect(await screen.findByText('Answer from the other tab.', {}, { timeout: 6000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('augur-elsewhere')).not.toBeInTheDocument());
  }, 15000);

  test('a stale lease means the owning tab died: the run is resumable', async () => {
    const now = Date.now();
    localStorage.setItem('augur-assistant-app/history', JSON.stringify([runningSession(now)]));
    localStorage.setItem('augur-assistant-app/current', 's-tab');
    localStorage.setItem('augur-assistant-app/lease/s-tab', JSON.stringify({ sessionId: 's-tab', tabId: 'dead-tab', heartbeat: now - 60_000 }));
    resetStoreForTests();
    renderPage();
    await screen.findByTestId('augur-interrupted');
    expect(screen.queryByTestId('augur-elsewhere')).not.toBeInTheDocument();
  });

  test('a running tab holds the lease and releases it when done', async () => {
    let release: (v: any) => void = () => undefined;
    modelScript = [new Promise((r) => (release = r))];
    renderPage();
    await ask('question');
    const leases = () => Object.keys(localStorage).filter((k) => k.startsWith('augur-assistant-app/lease/'));
    await waitFor(() => expect(leases()).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(leases()[0])!)).toMatchObject({ sessionId: leases()[0].split('/').pop() });
    await act(async () => release({ content: [{ type: 'text', text: 'done' }] }));
    await screen.findByText('done');
    await waitFor(() => expect(leases()).toHaveLength(0));
  });
});

test('a conversation whose run lock another tab holds is not run twice', async () => {
  // Another tab of the same origin holds every run lock.
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_n: string, _o: unknown, cb: (l: unknown) => unknown) => Promise.resolve(cb(null)) } });
  try {
    renderPage();
    await ask('racing question');
    expect(await screen.findByText(/running in another tab/i)).toBeInTheDocument();
    expect(modelCalls()).toHaveLength(0);
  } finally {
    delete (navigator as any).locks;
  }
});

describe('deleting a running conversation', () => {
  const rail = () => within(screen.getByRole('complementary', { name: 'Conversations' }));
  const row = (title: string) => rail().queryAllByTestId('augur-conversation').find((r) => r.textContent?.includes(title));
  const storedIds = () => (JSON.parse(localStorage.getItem('augur-assistant-app/history') ?? '[]') as Array<{ id: string; title: string }>).map((x) => x.title);
  const deleteRow = async (title: string) => {
    await waitFor(() => expect(row(title)).toBeTruthy());
    fireEvent.click(within(row(title)!).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row(title)!).getByRole('button', { name: /Stop and delete|^Delete$/ }));
  };
  // Lets the aborted run unwind, its finally block run and any debounced save fire.
  const settle = () => act(() => new Promise((r) => setTimeout(r, 450)));

  test.each([
    ['open', false],
    ['in the background', true],
  ])('while the model call is in flight (%s) it stays deleted', async (_label, background) => {
    let release: (v: any) => void = () => undefined;
    modelScript = [new Promise((r) => (release = r))];
    renderPage();
    await ask('secret incident');
    await waitFor(() => expect(modelCalls()).toHaveLength(1));
    if (background) {
      fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    }
    await deleteRow('secret incident');
    await act(async () => release({ content: [{ type: 'text', text: 'late answer' }] }));
    await settle();
    expect(storedIds()).not.toContain('secret incident');
    expect(row('secret incident')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('augur-assistant-app/deleted')!)).toHaveLength(1);
  });

  test('while an approval is pending it stays deleted, and the tool never runs', async () => {
    modelScript = [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'm2', name: 'mcp__wiki__create_page', input: { title: 'x' } }] }];
    renderPage();
    await ask('needs approval');
    await screen.findByTestId('augur-approval');
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await deleteRow('needs approval');
    await settle();
    expect(storedIds()).not.toContain('needs approval');
    expect(posted.some((p) => p.url.endsWith('/mcp/call'))).toBe(false);
  });

  test('while sub-agents are running it stays deleted', async () => {
    let releaseSub: (v: any) => void = () => undefined;
    modelScript = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'd1', name: 'delegate', input: { tasks: [{ name: 'logs', objective: 'find errors' }] } }] },
      new Promise((r) => (releaseSub = r)),
    ];
    renderPage('/a/augur-assistant-app?mode=investigate');
    await screen.findByText(/Describe the symptom to investigate/);
    await ask('sub-agent incident', /Investigate$/);
    await waitFor(() => expect(modelCalls()).toHaveLength(2));
    await deleteRow('sub-agent incident');
    await act(async () => releaseSub({ content: [{ type: 'text', text: 'brief' }] }));
    await settle();
    expect(storedIds()).not.toContain('sub-agent incident');
    expect(modelCalls()).toHaveLength(2); // the lead agent did not continue
  });
});

describe('scrolling the conversation', () => {
  // jsdom has no layout: give the transcript a size so it can be "scrolled".
  const sized = (el: HTMLElement, scrollHeight: number, clientHeight = 500) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  };

  test('the transcript scrolls on its own; scrolling up shows Jump to latest, which returns to the end', async () => {
    modelScript = [{ content: [{ type: 'text', text: 'answer one' }] }];
    renderPage();
    await ask('first question');
    await screen.findByText('answer one');
    const timeline = screen.getByTestId('claude-timeline');
    expect(timeline).toHaveAttribute('aria-label', 'Conversation');
    sized(timeline, 3000);
    timeline.scrollTop = 200;
    fireEvent.scroll(timeline);
    const jump = await screen.findByRole('button', { name: /Jump to latest/ });
    // New output while the user reads older messages doesn't yank them down.
    modelScript = [{ content: [{ type: 'text', text: 'answer two' }] }];
    await ask('second question');
    await screen.findByText('answer two');
    expect(timeline.scrollTop).toBe(200);
    fireEvent.click(jump);
    expect(timeline.scrollTop).toBe(3000);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument());
  });

  test('at the bottom, new output is followed and no jump button is shown', async () => {
    modelScript = [{ content: [{ type: 'text', text: 'answer one' }] }];
    renderPage();
    await ask('first question');
    await screen.findByText('answer one');
    const timeline = screen.getByTestId('claude-timeline');
    sized(timeline, 3000);
    timeline.scrollTop = 2500; // at the end
    fireEvent.scroll(timeline);
    modelScript = [{ content: [{ type: 'text', text: 'answer two' }] }];
    sized(timeline, 3600);
    await ask('second question');
    await screen.findByText('answer two');
    expect(timeline.scrollTop).toBe(3600);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
  });
});

describe('deleting history', () => {
  const stored = () => (JSON.parse(localStorage.getItem('augur-assistant-app/history') ?? '[]') as Array<{ title: string }>).map((x) => x.title).sort();
  const seed = () => {
    const mk = (id: string, mode: string, extra: object = {}) => ({
      id,
      title: id,
      mode,
      rangeKey: '1h',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
      items: [{ kind: 'user', text: id, mode }],
      messages: [],
      proposals: {},
      findings: [],
      hypotheses: [],
      ...extra,
    });
    localStorage.setItem(
      'augur-assistant-app/history',
      JSON.stringify([mk('chat one', 'chat'), mk('chat pinned', 'chat', { pinned: true }), mk('inv one', 'investigate'), mk('inv pinned', 'investigate', { pinned: true })])
    );
  };
  const openDialog = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Delete history/ }));
    return screen.getByRole('dialog');
  };

  test('deletes only investigations, sparing pinned ones by default', async () => {
    seed();
    renderPage();
    const dlg = await openDialog();
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Investigations' }));
    expect(within(dlg).getByText(/1 conversation will be deleted/)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete 1 conversation' }));
    await waitFor(() => expect(stored()).toEqual(['chat one', 'chat pinned', 'inv pinned']));
    expect(await screen.findByText('Deleted 1 conversation.')).toBeInTheDocument();
  });

  test('deletes everything including pinned, stops running conversations, and nothing comes back', async () => {
    seed();
    let release: (v: any) => void = () => undefined;
    modelScript = [new Promise((r) => (release = r))];
    renderPage();
    await ask('live question');
    await waitFor(() => expect(modelCalls()).toHaveLength(1));
    const dlg = await openDialog();
    fireEvent.click(within(dlg).getByRole('checkbox', { name: 'Include pinned conversations' }));
    expect(within(dlg).getByText(/5 conversations will be deleted, including 1 running \(stopped first\)/)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete 5 conversations' }));
    await act(async () => release({ content: [{ type: 'text', text: 'late' }] }));
    await act(() => new Promise((r) => setTimeout(r, 450)));
    expect(stored()).toEqual([]);
    expect(screen.queryAllByTestId('augur-conversation')).toHaveLength(0);
    expect(screen.queryByText('live question')).not.toBeInTheDocument();
  });

  test('cancelling deletes nothing', async () => {
    seed();
    renderPage();
    const dlg = await openDialog();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stored()).toEqual(['chat one', 'chat pinned', 'inv one', 'inv pinned']);
  });
});

describe('multiple conversations', () => {
  const rail = () => within(screen.getByRole('complementary', { name: 'Conversations' }));
  const row = (title: string) => rail().getAllByTestId('augur-conversation').find((r) => r.textContent?.includes(title))!;

  test('switching or starting a new conversation keeps runs going; Stop affects only the open one', async () => {
    let releaseA: (v: any) => void = () => undefined;
    modelScript = [new Promise((r) => (releaseA = r))];
    renderPage();
    await ask('first question');
    await waitFor(() => expect(modelCalls()).toHaveLength(1));

    // New conversation while A is running: A is not aborted and shows as running in the list.
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(screen.queryByText('first question', { selector: '[class*="user"] *, [class*="user"]' })).not.toBeInTheDocument();
    await waitFor(() => expect(row('first question')).toBeTruthy());
    expect(await screen.findByText('1 running')).toBeInTheDocument();

    // B runs alongside A, then is stopped; A keeps going.
    modelScript = [new Promise(() => undefined)];
    await ask('second question');
    await waitFor(() => expect(modelCalls()).toHaveLength(2));
    fireEvent.click(await screen.findByRole('button', { name: /^Stop$/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Stop$/ })).not.toBeInTheDocument());

    // A finishes in the background; opening it shows the answer.
    await act(async () => releaseA({ content: [{ type: 'text', text: 'Answer for A, finished in the background.' }] }));
    fireEvent.click(within(row('first question')).getByRole('button', { name: /first question/ }));
    expect(await screen.findByText('Answer for A, finished in the background.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Augur' })).not.toBeDisabled();
  });

  test(`at most ${3} conversations run at once`, async () => {
    modelScript = [new Promise(() => undefined), new Promise(() => undefined), new Promise(() => undefined)];
    renderPage();
    for (const q of ['one', 'two', 'three']) {
      await ask(q);
      await waitFor(() => expect(screen.getByRole('button', { name: /^Stop$/ })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    }
    await ask('four');
    expect(await screen.findByText(/3 conversations are already running/)).toBeInTheDocument();
    expect(modelCalls()).toHaveLength(3);
  });

  test('conversations can be searched, renamed, pinned and deleted', async () => {
    const now = Date.now();
    const conv = (id: string, title: string, ageMs: number, extra: any = {}) => ({
      id,
      title,
      mode: 'chat',
      rangeKey: '1h',
      createdAt: now - ageMs,
      updatedAt: now - ageMs,
      items: [{ kind: 'user', text: title, mode: 'chat' }, { kind: 'assistant', text: `answer to ${title}` }],
      messages: [],
      proposals: {},
      findings: [],
      hypotheses: [],
      ...extra,
    });
    localStorage.setItem('augur-assistant-app/history', JSON.stringify([conv('a', 'Checkout latency', 60_000), conv('b', 'Kafka lag', 3 * 864e5, { mode: 'investigate' })]));
    renderPage();
    await waitFor(() => expect(rail().getAllByTestId('augur-conversation')).toHaveLength(2));
    expect(rail().getByText('Today')).toBeInTheDocument();

    fireEvent.change(rail().getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'kafka' } });
    expect(rail().getAllByTestId('augur-conversation')).toHaveLength(1);
    fireEvent.change(rail().getByRole('textbox', { name: 'Search conversations' }), { target: { value: '' } });

    fireEvent.click(within(row('Kafka lag')).getByRole('button', { name: 'Rename' }));
    fireEvent.change(rail().getByRole('textbox', { name: 'Conversation name' }), { target: { value: 'Kafka consumer lag (payments)' } });
    fireEvent.click(rail().getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(row('Kafka consumer lag (payments)')).toBeTruthy());

    fireEvent.click(within(row('Kafka consumer lag')).getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(rail().getByText('Pinned')).toBeInTheDocument());
    const stored = JSON.parse(localStorage.getItem('augur-assistant-app/history')!);
    expect(stored[0]).toMatchObject({ id: 'b', title: 'Kafka consumer lag (payments)', pinned: true });

    fireEvent.click(within(row('Checkout latency')).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row('Checkout latency')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(rail().getAllByTestId('augur-conversation')).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('augur-assistant-app/history')!).map((x: any) => x.id)).toEqual(['b']);
  });
});
