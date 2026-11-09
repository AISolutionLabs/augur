import { configFromEnv, runHeadless } from './run';
import { DATASOURCES, NOW, fakeHttp, seriesResponse } from '../agent/testUtils';
import { MessagesRequest, MessagesResponse } from '../agent/types';

const reply = (content: any[]): MessagesResponse => ({
  id: 'm',
  type: 'message',
  role: 'assistant',
  model: 'x',
  content,
  stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
  usage: { input_tokens: 100, output_tokens: 10 },
});

function grafana(saveResult: unknown = { uid: 'd1', url: '/d/d1/x', status: 'success', version: 1 }) {
  return fakeHttp((c) => {
    if (c.url === '/api/datasources') {
      return DATASOURCES;
    }
    if (c.url === '/api/user') {
      return { login: 'bench' };
    }
    if (c.url === '/api/health') {
      return { version: '13.2.4' };
    }
    if (c.url === '/api/ds/query') {
      return seriesResponse([{ labels: { job: 'payments' }, values: [1, 2, 3] }]);
    }
    if (c.url === '/api/dashboards/db') {
      return saveResult;
    }
    return {};
  });
}

const sys = (r: MessagesRequest) => (typeof r.system === 'string' ? r.system : (r.system ?? []).map((b) => b.text).join('\n'));

const cfg = (over: Partial<ReturnType<typeof configFromEnv>> = {}) => ({
  ...configFromEnv({ AUGUR_NOW: new Date(NOW).toISOString(), AUGUR_APPLY: 'auto', MODEL: 'm' }, ['build a dashboard']),
  quiet: true,
  ...over,
});

const dashboardTurn = reply([
  {
    type: 'tool_use',
    id: 't1',
    name: 'draft_dashboard',
    input: { title: 'Payments', panels: [{ title: 'Rate', type: 'timeseries', datasource_uid: 'mimir', queries: [{ expr: 'sum(rate(x[5m]))' }] }], check_queries: false },
  },
]);

describe('headless runner', () => {
  it('auto-applies proposals, tells the model the outcome, and writes an ATIF trajectory', async () => {
    const http = grafana();
    const requests: MessagesRequest[] = [];
    const turns = [dashboardTurn, reply([{ type: 'text', text: 'Saved.' }])];
    const r = await runHeadless(cfg(), { http, call: async (req) => (requests.push(JSON.parse(JSON.stringify(req))), turns.shift()!) });

    expect(http.calls.some((c) => c.method === 'POST' && c.url === '/api/dashboards/db')).toBe(true);
    expect(r.applied).toEqual([{ kind: 'dashboard', message: 'Saved dashboard "Payments"', url: '/d/d1/x' }]);
    expect(JSON.stringify(requests[1].messages)).toContain('[applied automatically: Saved dashboard');
    expect(sys(requests[0])).toContain('This run is unattended');
    expect(r.answer).toBe('Saved.');
    const steps = (r.trajectory as any).steps;
    expect(steps.map((s: any) => s.source)).toEqual(['system', 'user', 'agent', 'agent']);
    expect(steps[2].tool_calls[0]).toMatchObject({ tool_call_id: 't1', function_name: 'draft_dashboard' });
    expect(steps[2].observation.results[0].content).toContain('applied automatically');
    expect((r.trajectory as any).final_metrics).toMatchObject({ total_prompt_tokens: 200, total_completion_tokens: 20 });
  });

  it('reports a failed apply to the model instead of pretending it worked', async () => {
    const err = Object.assign(new Error('HTTP 412'), { status: 412, data: { message: 'version-mismatch' } });
    const http = grafana(err);
    const requests: MessagesRequest[] = [];
    const turns = [dashboardTurn, reply([{ type: 'text', text: 'Could not save.' }])];
    const r = await runHeadless(cfg(), { http, call: async (req) => (requests.push(JSON.parse(JSON.stringify(req))), turns.shift()!) });
    expect(r.applied[0]).toMatchObject({ kind: 'dashboard', error: 'version-mismatch' });
    expect(JSON.stringify(requests[1].messages)).toContain('[automatic apply FAILED: version-mismatch]');
  });

  it('does not offer proposal tools or the unattended note unless apply is auto', async () => {
    const requests: MessagesRequest[] = [];
    await runHeadless(cfg({ apply: 'off' }), { http: grafana(), call: async (req) => (requests.push(req), reply([{ type: 'text', text: 'ok' }])) });
    const names = (requests[0].tools ?? []).map((t) => t.name);
    expect(names).toContain('query_prometheus');
    expect(names).not.toContain('draft_dashboard');
    expect(sys(requests[0])).not.toContain('unattended');
  });

  it('uses the scenario clock for the prompt and tool time range', async () => {
    const requests: MessagesRequest[] = [];
    await runHeadless(cfg(), { http: grafana(), call: async (req) => (requests.push(req), reply([{ type: 'text', text: 'ok' }])) });
    expect(sys(requests[0])).toContain('Current time: 2026-11-09T12:00:00Z');
  });

  it('rejects bad configuration', () => {
    expect(() => configFromEnv({}, [])).toThrow(/prompt/);
    expect(() => configFromEnv({ AUGUR_MODE: 'x' }, ['q'])).toThrow(/AUGUR_MODE/);
    expect(() => configFromEnv({ AUGUR_NOW: 'nope' }, ['q'])).toThrow(/AUGUR_NOW/);
  });
});
