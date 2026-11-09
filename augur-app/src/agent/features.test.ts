import { skillTools, memoryTool } from './tools/knowledge';
import { parseSkillMarkdown } from '../skillFormat';
import { expandSlashCommand } from '../session/useAugurSession';
import { scanInfrastructure } from './memoryScan';
import { buildDashboardEdit, queryProfiles, draftAlertRule } from './tools/actions';
import { delegateTool, hypothesisTool } from './tools/investigation';
import { mcpTools } from './tools/mcp';
import { buildInvestigationDashboard } from './investigations';
import { conclusionGate, buildSystemPrompt } from './prompts';
import { describeLocation } from '../session/pageContext';
import { exploreUrl } from './links';
import { readOnlyTools, buildToolset } from './tools';
import { ctxWith, fakeHttp, NOW, DATASOURCES, seriesResponse } from './testUtils';
import { MessagesRequest, MessagesResponse } from './types';

const SKILLS = [
  { name: 'kafka-lag', title: 'Kafka consumer lag', description: 'When consumers fall behind', tags: ['kafka'], body: 'Check kafka_consumergroup_lag.', enabled: true },
  { name: 'old', title: 'Disabled', description: 'x', body: 'x', enabled: false },
];

describe('skills', () => {
  it('searches and reads enabled skills only', async () => {
    const [search, read] = skillTools(SKILLS);
    const ctx = ctxWith(fakeHttp(() => ({})));
    expect(await search.run({ query: 'kafka lag' }, ctx)).toContain('kafka-lag');
    expect(await search.run({ query: 'Disabled' }, ctx)).toBe('No matching skills.');
    expect(await read.run({ name: 'kafka-lag' }, ctx)).toContain('kafka_consumergroup_lag');
    await expect(read.run({ name: 'old' }, ctx)).rejects.toThrow(/not found/);
    expect(skillTools([])).toEqual([]);
  });
  it('expands /commands with arguments and leaves other text alone', () => {
    const r = expandSlashCommand('/kafka-lag orders-topic', SKILLS);
    expect(r.skill?.name).toBe('kafka-lag');
    expect(r.userText).toContain('with: orders-topic');
    expect(r.userText).toContain('Check kafka_consumergroup_lag.');
    expect(expandSlashCommand('/old', SKILLS).skill).toBeUndefined();
    expect(expandSlashCommand('hello /kafka-lag', SKILLS).userText).toBe('hello /kafka-lag');
  });
  it('parses markdown skills with and without front matter', () => {
    const a = parseSkillMarkdown('---\nname: DB Pool\ndescription: "Pool exhaustion"\ntags: [postgres, db]\n---\n# Database pool\nSteps...');
    expect(a).toMatchObject({ name: 'db-pool', title: 'Database pool', description: 'Pool exhaustion', tags: ['postgres', 'db'] });
    const b = parseSkillMarkdown('# Restart storms\nWhen pods crashloop.\n\n1. check', 'restarts.md');
    expect(b).toMatchObject({ name: 'restart-storms', description: 'When pods crashloop.' });
  });
});

describe('infrastructure memory', () => {
  it('discovers services across signals and the Tempo service graph', async () => {
    const http = fakeHttp((c) => {
      if (c.url.endsWith('/label/__name__/values')) {
        return { data: ['traces_service_graph_request_total', 'traces_service_graph_request_failed_total', 'http_requests_total'] };
      }
      if (c.url.endsWith('/label/service_name/values') && c.url.includes('mimir')) {
        return { data: ['checkout', 'payments'] };
      }
      if (c.url.includes('/uid/loki/resources/labels')) {
        return { data: ['service_name', 'level', 'namespace'] };
      }
      if (c.url.includes('/uid/loki/resources/label/service_name/values')) {
        return { data: ['checkout', 'frontend'] };
      }
      if (c.url.includes('/uid/tempo/')) {
        return { tagValues: [{ value: 'checkout' }, { value: 'payments' }] };
      }
      if (c.url === '/api/ds/query') {
        const failed = c.body.queries[0].expr.includes('failed');
        return {
          results: {
            A: {
              frames: [
                {
                  schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { client: 'checkout', server: 'payments' } }] },
                  data: { values: [[NOW], [failed ? 0.5 : 10]] },
                },
              ],
            },
          },
        };
      }
      return new Error('nope');
    });
    const mem = await scanInfrastructure(http, DATASOURCES, { now: NOW, user: 'admin' });
    const checkout = mem.services.find((s) => s.name === 'checkout')!;
    expect(checkout.sources.length).toBeGreaterThanOrEqual(3);
    expect(mem.edges[0]).toMatchObject({ client: 'checkout', server: 'payments', rps: 10, errorRate: 0.05 });
    expect(mem.summary).toContain('services discovered');
    const out = await memoryTool(mem)[0].run({ service: 'pay' }, ctxWith(http));
    expect(out).toContain('checkout → payments 10.00 rps 5.00% err');
  });
});

describe('dashboard edits', () => {
  const dash = {
    dashboard: {
      uid: 'd',
      title: 'Svc',
      version: 3,
      panels: [
        { id: 1, type: 'row', title: 'R', collapsed: true, panels: [{ id: 2, type: 'stat', title: 'Inner', gridPos: { x: 0, y: 1, w: 6, h: 4 } }], gridPos: { x: 0, y: 0, w: 24, h: 1 } },
        { id: 3, type: 'timeseries', title: 'Lat', gridPos: { x: 0, y: 1, w: 12, h: 8 }, targets: [{ refId: 'A', expr: 'old' }], datasource: { uid: 'mimir', type: 'prometheus' } },
      ],
      templating: { list: [] },
    },
    meta: { folderUid: 'f', canSave: true },
  };
  it('removes nested panels, updates queries and appends below existing content', async () => {
    const http = fakeHttp((c) => (c.method === 'GET' ? JSON.parse(JSON.stringify(dash)) : seriesResponse([{ labels: {}, values: [1] }])));
    const p = await buildDashboardEdit(
      { dashboard_uid: 'd', remove_panel_ids: [2], update_panels: [{ panel_id: 3, unit: 's', queries: [{ expr: 'new_expr' }] }], add_panels: [{ title: 'N', type: 'stat', datasource_uid: 'mimir', queries: [{ expr: 'up' }] }], set: { tags: ['x'] } },
      ctxWith(http)
    );
    expect(p.json.panels[0].panels).toHaveLength(0);
    const lat = p.json.panels.find((x: any) => x.id === 3);
    expect(lat.targets[0].expr).toBe('new_expr');
    expect(lat.fieldConfig.defaults.unit).toBe('s');
    const added = p.json.panels.find((x: any) => x.title === 'N');
    expect(added.id).toBe(4);
    expect(added.gridPos.y).toBe(9);
    expect(p.baseVersion).toBe(3);
    expect(p.json.version).toBe(3);
    expect(p.changes.join('\n')).toMatch(/remove panel \[2\][\s\S]*update panel \[3\][\s\S]*add panel "N"/);
  });
  it('refuses dashboards the user cannot save and v2 dashboards', async () => {
    await expect(buildDashboardEdit({ dashboard_uid: 'd', set: { title: 'x' } }, ctxWith(fakeHttp(() => ({ ...dash, meta: { canSave: false } }))))).rejects.toThrow(/permission/);
    await expect(buildDashboardEdit({ dashboard_uid: 'd', set: { title: 'x' } }, ctxWith(fakeHttp(() => ({ dashboard: { elements: {} } }))))).rejects.toThrow(/v2/);
    await expect(buildDashboardEdit({ dashboard_uid: 'd' }, ctxWith(fakeHttp(() => JSON.parse(JSON.stringify(dash)))))).rejects.toThrow(/no changes/);
  });
});

describe('alert rules and profiles', () => {
  it('builds a Loki alert rule with an instant query and gte mapped to gt', async () => {
    const proposals: any[] = [];
    await draftAlertRule.run(
      { title: 'Errors', folder_uid: 'f', group: 'g', datasource_uid: 'loki', expr: 'sum(count_over_time({app="x"} |= "error" [5m]))', operator: 'gte', threshold: 10 },
      ctxWith(fakeHttp(() => seriesResponse([{ labels: {}, values: [12] }])), { propose: (p) => proposals.push(p) })
    );
    const rule = proposals[0].rule;
    expect(rule.data[0].model).toMatchObject({ queryType: 'instant' });
    expect(rule.data[2].model.conditions[0].evaluator).toEqual({ type: 'gt', params: [10] });
    expect(proposals[0].preview).toContain('last=12');
  });
  it('summarises Pyroscope flame graphs with enum labels', async () => {
    const ds = [...DATASOURCES, { uid: 'pyro', name: 'Pyroscope', type: 'grafana-pyroscope-datasource' }];
    const http = fakeHttp(() => ({
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'level', type: 'number' },
                  { name: 'value', type: 'number' },
                  { name: 'self', type: 'number' },
                  { name: 'label', type: 'enum', config: { type: { enum: { text: ['total', 'main', 'json.Marshal', 'gc'] } } } } as any,
                ],
              },
              data: { values: [[0, 1, 2, 2], [100, 100, 60, 30], [0, 10, 60, 30], [0, 1, 2, 3]] },
            },
          ],
        },
      },
    }));
    const out = await queryProfiles.run({ datasource_uid: 'pyro', profile_type: 'cpu', label_selector: '{service_name="x"}' }, ctxWith(http, { listDataSources: () => ds }));
    expect(out.indexOf('json.Marshal')).toBeLessThan(out.indexOf('gc'));
    expect(out).toContain('60.0% / 60.0%  json.Marshal');
  });
});

describe('investigation mechanics', () => {
  it('conclusion gate asks to challenge the leading unchallenged hypothesis once', () => {
    expect(conclusionGate([])).toMatch(/not recorded any hypotheses/);
    const h = [
      { id: 'a', statement: 'deploy', status: 'supported' as const, confidence: 0.8, updatedAt: 1 },
      { id: 'b', statement: 'db', status: 'open' as const, confidence: 0.3, updatedAt: 1 },
    ];
    expect(conclusionGate(h)).toContain('"deploy"');
    expect(conclusionGate([{ ...h[0], challenged: true }, h[1]])).toBeUndefined();
  });

  it('hypothesis tool clamps confidence', async () => {
    const got: any[] = [];
    await hypothesisTool().run({ key: 'k', statement: 's', status: 'open', confidence: 7 }, ctxWith(fakeHttp(() => ({})), { updateHypothesis: (x) => got.push(x) }));
    expect(got[0].confidence).toBe(1);
  });

  it('delegate runs sub-agents in parallel with their own context and returns their briefs', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const call = async (req: MessagesRequest): Promise<MessagesResponse> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      const objective = JSON.stringify(req.messages[0]);
      const hasResult = req.messages.length > 1;
      if (!hasResult) {
        return { id: 'x', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'list_datasources', input: {} }] };
      }
      return { id: 'x', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: `FINDINGS for ${objective.includes('logs') ? 'logs' : 'metrics'}` }] };
    };
    const events: any[] = [];
    const tool = delegateTool({ call, baseSystem: 'base', onEvent: (e) => events.push(e), subTools: () => readOnlyTools({}) });
    expect(tool.schema.name).toBe('delegate');
    const out = await tool.run({ tasks: [{ name: 'metrics', objective: 'golden signals' }, { name: 'logs', objective: 'error logs' }] }, ctxWith(fakeHttp(() => ({}))));
    expect(maxInFlight).toBe(2);
    expect(out).toContain('### metrics\nFINDINGS for metrics');
    expect(out).toContain('### logs\nFINDINGS for logs');
    expect(events.filter((e) => e.kind === 'tool_start').map((e) => e.agent).sort()).toEqual(['logs', 'metrics']);
  });

  it('investigate toolset includes delegate only when enabled; sub-agents cannot propose changes', () => {
    const names = (t: any[]) => t.map((x) => x.schema.name);
    expect(names(buildToolset('investigate'))).not.toContain('delegate');
    const withDelegate = buildToolset('investigate', { delegate: { call: async () => ({}) as any, baseSystem: '', onEvent: () => undefined } });
    expect(names(withDelegate)).toContain('delegate');
    const sub = names(readOnlyTools({}));
    expect(sub).not.toContain('draft_dashboard');
    expect(sub).not.toContain('draft_silence');
    expect(sub).not.toContain('propose_dashboard_edit');
  });

  it('saved investigation dashboards embed the report and deduplicated evidence panels', () => {
    const d = buildInvestigationDashboard(
      {
        title: 'Investigation: x',
        question: 'why',
        report: '## Summary\nroot cause',
        findings: [{ title: 'f', detail: 'd', severity: 'high', at: NOW }],
        hypotheses: [{ id: 'h', statement: 'deploy', status: 'confirmed', confidence: 0.9, challenged: true, updatedAt: NOW }],
        evidence: [
          { tool: 'query_prometheus', input: { datasource_uid: 'mimir', expr: 'up' }, ok: true },
          { tool: 'query_prometheus', input: { datasource_uid: 'mimir', expr: 'up' }, ok: true },
          { tool: 'query_loki', input: { datasource_uid: 'loki', expr: '{app="x"} |= "error"' }, ok: true },
          { tool: 'search_traces', input: { datasource_uid: 'tempo', traceql: '{status=error}' }, ok: true },
          { tool: 'query_prometheus', input: { datasource_uid: 'mimir', expr: 'bad' }, ok: false },
        ],
        range: { from: NOW - 3600_000, to: NOW },
      },
      DATASOURCES
    );
    expect(d.tags).toContain('augur-investigation');
    const evidence = d.panels.filter((p: any) => p.targets);
    expect(evidence.map((p: any) => p.type)).toEqual(['timeseries', 'logs', 'table']);
    expect(d.panels[0].options.content).toContain('root cause');
    expect(d.panels[2].options.content).toContain('CONFIRMED');
  });
});

describe('MCP tools in the browser', () => {
  const catalog = {
    servers: [
      {
        name: 'gh',
        tools: [
          { name: 'get_pr', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'merge_pr', inputSchema: { type: 'object' } },
        ],
      },
    ],
  };
  it('declined approvals never reach the server; errors surface as tool errors', async () => {
    const http = fakeHttp((c) => (c.body.tool === 'get_pr' ? { content: [{ type: 'text', text: 'boom' }], isError: true } : { content: [] }));
    const [get, merge] = mcpTools(catalog, 'claude');
    expect(get.schema.name).toBe('mcp__gh__get_pr');
    const out = await merge.run({}, ctxWith(http, { confirm: async () => false }));
    expect(out).toMatch(/declined/);
    expect(http.calls).toHaveLength(0);
    await expect(get.run({}, ctxWith(http))).rejects.toThrow('boom');
  });
});

describe('links and page context', () => {
  it('builds Explore links and describes Grafana pages', () => {
    const u = exploreUrl(DATASOURCES[0], { expr: 'up' }, 1, 2);
    expect(decodeURIComponent(u)).toContain('"expr":"up"');
    expect(describeLocation({ pathname: '/d/abc/x', search: '?from=now-1h&to=now&var-ns=prod&viewPanel=4' })).toBe(
      'Dashboard uid abc, panel 4 time range now-1h → now, variables ns=prod (use get_dashboard).'
    );
    expect(describeLocation({ pathname: '/explore', search: `?panes=${encodeURIComponent(JSON.stringify({ a: { datasource: 'mimir', queries: [{ expr: 'rate(x[5m])' }], range: { from: 'now-1h', to: 'now' } } }))}` })).toContain('rate(x[5m])');
    expect(describeLocation({ pathname: '/alerting/grafana/r1/view', search: '' })).toContain('r1');
  });
  it('system prompt carries rules, personal rules, memory and page context', () => {
    const p = buildSystemPrompt({
      mode: 'chat',
      now: NOW,
      range: { from: NOW - 1, to: NOW },
      datasources: DATASOURCES,
      rules: [{ id: '1', text: 'Org rule', scope: 'all', enabled: true }, { id: '2', text: 'Off', scope: 'all', enabled: false }],
      personalRules: [{ id: '3', text: 'Use tables', scope: 'all', enabled: true }],
      memorySummary: 'Environment: 12 services',
      pageContext: 'Dashboard uid abc',
    });
    expect(p).toContain('Org rule');
    expect(p).not.toContain('- Off');
    expect(p).toContain('Use tables');
    expect(p).toContain('Environment: 12 services');
    expect(p).toContain('Dashboard uid abc');
  });
});

describe('prompt review follow-ups', () => {
  it('reminds the investigator to update the board after several silent rounds, once per gap', async () => {
    const { stateReminder, STATE_REMINDER_AFTER } = await import('./prompts');
    const r = stateReminder();
    const outs = Array.from({ length: STATE_REMINDER_AFTER }, () => r(['query_prometheus']));
    expect(outs.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(outs[outs.length - 1]).toMatch(/record_finding/);
    expect(r(['query_loki'])).toBeUndefined(); // counter reset after a reminder
    expect(r(['delegate'])).toBeUndefined(); // waiting on sub-agents is not "silent"
    r(['a']);
    r(['b']);
    expect(r(['update_hypothesis', 'query_loki'])).toBeUndefined(); // state update resets
  });

  it('runner appends the reminder to the tool-result turn', async () => {
    const { runAgent } = await import('./runner');
    const requests: any[] = [];
    const responses: any[] = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'list_datasources', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    ];
    await runAgent({
      call: async (req) => {
        requests.push(JSON.parse(JSON.stringify(req)));
        return { id: 'm', type: 'message', role: 'assistant', model: 'x', ...responses.shift() };
      },
      tools: readOnlyTools({}),
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      ctx: ctxWith(fakeHttp(() => ({}))),
      onEvent: () => undefined,
      maxSteps: 5,
      afterTools: () => 'REMEMBER',
    });
    const last = requests[1].messages[2].content;
    expect(last[last.length - 1]).toMatchObject({ type: 'text', text: 'REMEMBER' });
  });

  it('prompt carries timezone with local time and the code-formatting rule', async () => {
    const { buildSystemPrompt, localTime, resolveTimezone } = await import('./prompts');
    const p = buildSystemPrompt({ mode: 'investigate', now: NOW, range: { from: NOW - 1, to: NOW }, datasources: DATASOURCES, timezone: 'Asia/Kolkata' });
    expect(p).toContain("User's timezone: Asia/Kolkata (17:30 UTC+5:30 local now)");
    expect(p).toContain('__name__ becomes bold');
    expect(p).toContain('call record_finding and/or update_hypothesis before continuing');
    expect(localTime(NOW, 'Not/AZone')).toBe('Not/AZone');
    expect(resolveTimezone('utc')).toBe('UTC');
    expect(resolveTimezone('Europe/London')).toBe('Europe/London');
    expect(resolveTimezone('browser')).toBeTruthy();
  });
});

describe('toolset review follow-ups', () => {
  it('MCP tool names stay unique after sanitising and truncation', async () => {
    const { mcpToolName, mcpTools } = await import('./tools/mcp');
    const taken = new Set<string>();
    const a = mcpToolName('gh', 'get_pr', taken);
    taken.add(a);
    expect(a).toBe('mcp__gh__get_pr');
    const b = mcpToolName('gh', 'get.pr', taken);
    expect(b).not.toBe(a);
    expect(b).toMatch(/^mcp__gh__get_pr_[0-9a-z]{6}$/);
    const long = 'x'.repeat(80);
    const l1 = mcpToolName('srv', `${long}_one`, new Set());
    const l2 = mcpToolName('srv', `${long}_two`, new Set([l1]));
    expect(l1.length).toBeLessThanOrEqual(64);
    expect(l2.length).toBeLessThanOrEqual(64);
    expect(l1).not.toBe(l2);
    const tools = mcpTools({ servers: [{ name: 'gh', tools: [{ name: 'get.pr' }, { name: 'get_pr' }] }] }, 'claude');
    expect(new Set(tools.map((t) => t.schema.name)).size).toBe(2);
  });

  it('sub-agents get read-only MCP tools only; proposal tools exist only with a UI', async () => {
    const { mcpTools } = await import('./tools/mcp');
    const mcp = mcpTools(
      { servers: [{ name: 'gh', tools: [{ name: 'search_issues', annotations: { readOnlyHint: true } }, { name: 'close_issue' }] }] },
      'claude'
    );
    const names = (t: any[]) => t.map((x) => x.schema.name);
    const sub = names(readOnlyTools({ mcp }));
    expect(sub).toContain('mcp__gh__search_issues');
    expect(sub).not.toContain('mcp__gh__close_issue');
    expect(sub).toContain('list_silences');

    const headless = names(buildToolset('chat', { mcp }));
    expect(headless).not.toEqual(expect.arrayContaining(['draft_dashboard']));
    expect(headless).not.toContain('draft_silence');
    expect(headless).toContain('mcp__gh__close_issue');
    const withUi = names(buildToolset('chat', { mcp, propose: () => undefined }));
    expect(withUi).toEqual(expect.arrayContaining(['draft_dashboard', 'propose_dashboard_edit', 'draft_silence', 'draft_alert_rule']));
  });

  it('proposal tools fail loudly instead of claiming success when nothing can show them', async () => {
    const { draftSilence } = await import('./tools/actions');
    await expect(
      draftSilence.run({ matchers: [{ name: 'a', value: 'b' }], duration: '1h', comment: 'x' }, ctxWith(fakeHttp(() => [])))
    ).rejects.toThrow(/not available in this context/);
  });
});
