import { capabilitiesSummary, capabilitiesTool, CORE_PANELS, loadCapabilities } from './capabilities';
import { buildSystemPrompt } from './prompts';
import { fakeHttp, NOW, DATASOURCES } from './testUtils';

const PLUGINS = [
  { id: 'timeseries', name: 'Time series', type: 'panel', signature: 'internal', info: { version: '' } },
  { id: 'logs', name: 'Logs', type: 'panel', signature: 'internal', info: {} },
  { id: 'grafana-polystat-panel', name: 'Polystat', type: 'panel', signature: 'valid', info: { version: '2.1.4' } },
  { id: 'grafana-lokiexplore-app', name: 'Grafana Logs Drilldown', type: 'app', signature: 'valid', info: { version: '1.0.20' } },
  { id: 'grafana-slo-app', name: 'SLO', type: 'app', info: { version: '1.9.0' } },
  { id: 'acme-thing-app', name: 'Acme Thing', type: 'app', info: { description: 'Internal portal' } },
  { id: 'augur-assistant-app', name: 'Augur', type: 'app', info: { version: '1.6.0' } },
  { id: 'prometheus', name: 'Prometheus', type: 'datasource', signature: 'internal', info: {} },
  { id: 'old-app', name: 'Disabled', type: 'app', enabled: false, info: {} },
];

describe('Grafana capabilities', () => {
  it('reads installed plugins, panel types and versions', async () => {
    const http = fakeHttp((c) => (c.url === '/api/plugins' ? PLUGINS : {}));
    const c = await loadCapabilities(http, '13.2.4');
    expect(http.calls[0]).toMatchObject({ url: '/api/plugins', params: { enabled: 1 } });
    expect([...c.panels].sort()).toEqual(['grafana-polystat-panel', 'logs', 'timeseries']);
    expect(c.plugins.find((p) => p.id === 'old-app')).toBeUndefined();
    expect(c.plugins.find((p) => p.id === 'timeseries')?.core).toBe(true);
  });

  it('falls back to core panels when the plugin list cannot be read', async () => {
    const http = fakeHttp(() => {
      throw new Error('forbidden');
    });
    const c = await loadCapabilities(http, '12.0.0');
    expect(c.error).toBe('forbidden');
    expect([...c.panels]).toEqual(CORE_PANELS);
  });

  it('summarises apps with what they are for, panel types, and non-core panels for the prompt', async () => {
    const c = await loadCapabilities(fakeHttp(() => PLUGINS), '13.2.4');
    const text = capabilitiesSummary(c);
    expect(text).toContain('Installed in this Grafana (13.2.4)');
    expect(text).toContain('Grafana Logs Drilldown (grafana-lokiexplore-app 1.0.20): Logs Drilldown: queryless log exploration');
    expect(text).toContain('SLO (grafana-slo-app 1.9.0): SLO: service level objectives');
    expect(text).toContain('Acme Thing (acme-thing-app)');
    expect(text).not.toContain('augur-assistant-app');
    expect(text).toContain('Panel types for dashboards: grafana-polystat-panel, logs, timeseries');
    expect(text).toContain('Non-core panel plugins: grafana-polystat-panel 2.1.4');

    const prompt = buildSystemPrompt({ mode: 'chat', now: NOW, range: { from: NOW - 36e5, to: NOW }, datasources: DATASOURCES, capabilities: c });
    expect(prompt).toContain('Grafana Logs Drilldown');
  });

  it('grafana_capabilities lists and filters plugins', async () => {
    const c = await loadCapabilities(fakeHttp(() => PLUGINS), '13.2.4');
    const tool = capabilitiesTool(async () => c);
    const apps = await tool.run({ type: 'app' }, {} as any);
    expect(apps).toContain('Grafana 13.2.4');
    expect(apps).toContain('app | grafana-slo-app | SLO | 1.9.0 | SLO: service level objectives');
    expect(apps).not.toContain('timeseries');
    expect(await tool.run({ query: 'polystat' }, {} as any)).toContain('panel | grafana-polystat-panel | Polystat | 2.1.4');
    expect(tool.readOnly).toBe(true);
  });
});
