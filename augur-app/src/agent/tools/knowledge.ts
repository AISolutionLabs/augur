// Skills (team runbooks), infrastructure memory and past investigations.

import { ToolDefinition } from '../types';
import { InfraMemory, Skill } from '../../settings';
import { clip } from '../frames';
import { flattenPanels } from './grafanaObjects';
import { INVESTIGATION_TAG } from '../investigations';

function score(text: string, terms: string[]): number {
  const t = text.toLowerCase();
  return terms.reduce((acc, w) => acc + (t.includes(w) ? (w.length > 3 ? 2 : 1) : 0), 0);
}

export function skillTools(skills: Skill[]): ToolDefinition[] {
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) {
    return [];
  }
  return [
    {
      schema: {
        name: 'search_skills',
        description:
          "Search the team's skills (runbooks, service guides, investigation playbooks). Do this at the start of any investigation or unfamiliar task; when a skill matches, read it with read_skill and follow it.",
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      describe: (i) => `Search skills: ${i.query}`,
      run: async (input) => {
        const terms = String(input.query ?? '')
          .toLowerCase()
          .split(/\W+/)
          .filter(Boolean);
        const ranked = enabled
          .map((s) => ({ s, n: score(`${s.name} ${s.title} ${s.description} ${(s.tags ?? []).join(' ')}`, terms) * 3 + score(s.body, terms) }))
          .filter((x) => x.n > 0)
          .sort((a, b) => b.n - a.n)
          .slice(0, 8);
        return ranked.length
          ? ranked.map((x) => `${x.s.name} — ${x.s.title}: ${x.s.description}${x.s.tags?.length ? ` [${x.s.tags.join(', ')}]` : ''}`).join('\n')
          : 'No matching skills.';
      },
    },
    {
      schema: {
        name: 'read_skill',
        description: 'Read the full instructions of a skill by name.',
        input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      describe: (i) => `Read skill ${i.name}`,
      run: async (input) => {
        const s = enabled.find((x) => x.name === input.name);
        if (!s) {
          throw new Error(`skill "${input.name}" not found; use search_skills`);
        }
        return clip(`# ${s.title}\n${s.description}\n\n${s.body}`, 20_000);
      },
    },
  ];
}

export function memoryTool(memory?: InfraMemory): ToolDefinition[] {
  if (!memory) {
    return [];
  }
  return [
    {
      schema: {
        name: 'get_infrastructure_memory',
        description:
          'Look up what Augur knows about the environment from the last infrastructure scan: services and where their telemetry lives (which datasource/labels), namespaces, and service-to-service dependencies with request and error rates from the Tempo service graph. Filter by service name.',
        input_schema: { type: 'object', properties: { service: { type: 'string', description: 'Substring of a service name' } } },
      },
      describe: (i) => `Infrastructure memory${i.service ? `: ${i.service}` : ''}`,
      run: async (input) => {
        const q = String(input.service ?? '').toLowerCase();
        const svcs = memory.services.filter((s) => !q || s.name.toLowerCase().includes(q)).slice(0, 80);
        const edges = memory.edges.filter((e) => !q || e.client.toLowerCase().includes(q) || e.server.toLowerCase().includes(q)).slice(0, 80);
        return clip(
          [
            `Scanned ${new Date(memory.scannedAt).toISOString()}${memory.scannedBy ? ` by ${memory.scannedBy}` : ''}.`,
            q ? '' : memory.summary,
            `Services (${svcs.length}):`,
            ...svcs.map((s) => `- ${s.name}: ${s.sources.join(', ')}${s.namespaces?.length ? ` ns=${s.namespaces.join(',')}` : ''}`),
            edges.length ? `Dependencies (client → server, req/s, error %):` : 'No dependency edges recorded.',
            ...edges.map((e) => `- ${e.client} → ${e.server}${e.rps !== undefined ? ` ${e.rps.toFixed(2)} rps` : ''}${e.errorRate !== undefined ? ` ${(e.errorRate * 100).toFixed(2)}% err` : ''}`),
          ]
            .filter(Boolean)
            .join('\n')
        );
      },
    },
  ];
}

export const searchPastInvestigations: ToolDefinition = {
  schema: {
    name: 'search_past_investigations',
    description:
      'Search investigations previously saved to Grafana by Augur users (title and tags). Useful to check whether this problem has happened before and what the root cause was. Read one with read_past_investigation.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  describe: (i) => `Past investigations${i.query ? `: ${i.query}` : ''}`,
  run: async (input, ctx) => {
    const hits = await ctx.http.get<Array<{ uid: string; title: string; tags?: string[]; folderTitle?: string; url?: string }>>(
      '/api/search',
      { type: 'dash-db', tag: INVESTIGATION_TAG, query: input.query ?? '', limit: 30 },
      ctx.signal
    );
    return hits?.length ? hits.map((h) => `${h.uid} | ${h.title} | ${(h.tags ?? []).filter((t) => t !== INVESTIGATION_TAG).join(',')} | ${h.url ?? ''}`).join('\n') : 'No saved investigations found.';
  },
};

export const readPastInvestigation: ToolDefinition = {
  schema: {
    name: 'read_past_investigation',
    description: 'Read the report of a saved investigation (dashboard uid from search_past_investigations).',
    input_schema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] },
  },
  describe: (i) => `Read investigation ${i.uid}`,
  run: async (input, ctx) => {
    const r = await ctx.http.get<{ dashboard: any }>(`/api/dashboards/uid/${encodeURIComponent(input.uid)}`, undefined, ctx.signal);
    const texts = flattenPanels(r.dashboard)
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.options?.content ?? '')
      .join('\n\n');
    return clip(`${r.dashboard.title}\n\n${texts || '(no report text)'}`, 12_000);
  },
};
