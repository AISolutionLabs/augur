// Tools that prepare write actions (dashboard edits, silences, alert rules) as proposals for the
// user to approve, plus continuous profiling (Pyroscope).

import { DataSourceInfo, ToolContext, ToolDefinition } from '../types';
import { AnnotationSpec, buildAnnotation, buildPanel, buildTargets, buildVariable, checkQueries, layout, PanelSpec, VariableSpec } from '../dashboard';
import { annotationSchema } from './dashboards';
import { DashboardEditProposal, proposalId, SilenceProposal, AlertRuleProposal } from '../proposals';
import { dsQuery, dsResource, findDataSource, LOKI_TYPES, PROM_TYPES } from '../grafana';
import { clip, framesOf, summarizeTimeSeries } from '../frames';
import { iso, parseDurationSeconds, resolveRange } from '../time';
import { dashboardUrl } from '../links';

/** Proposal tools must not pretend to have shown something when no UI can receive it. */
export function requirePropose(ctx: ToolContext) {
  if (!ctx.propose) {
    throw new Error('proposals are not available in this context (no user interface to review them); describe the change in your answer instead');
  }
  return ctx.propose;
}

// ---------------------------------------------------------------- dashboard edits

interface PanelPatch extends Partial<PanelSpec> {
  panel_id: number;
}

interface EditInput {
  dashboard_uid: string;
  summary?: string;
  add_panels?: PanelSpec[];
  update_panels?: PanelPatch[];
  remove_panel_ids?: number[];
  add_variables?: VariableSpec[];
  add_annotations?: AnnotationSpec[];
  set?: { title?: string; description?: string; tags?: string[]; time_from?: string; refresh?: string };
}

function walkPanels(panels: any[] | undefined, fn: (p: any, parent: any[]) => void) {
  for (const p of [...(panels ?? [])]) {
    fn(p, panels!);
    if (p.panels?.length) {
      walkPanels(p.panels, fn);
    }
  }
}

export async function buildDashboardEdit(input: EditInput, ctx: ToolContext): Promise<DashboardEditProposal> {
  const resp = await ctx.http.get<{ dashboard: any; meta?: { folderUid?: string; url?: string; canSave?: boolean } }>(
    `/api/dashboards/uid/${encodeURIComponent(input.dashboard_uid)}`,
    undefined,
    ctx.signal
  );
  const original = resp.dashboard;
  if (!original?.panels && original?.elements) {
    throw new Error('this dashboard uses the v2 schema, which Augur cannot edit yet; propose a new dashboard instead');
  }
  if (resp.meta && resp.meta.canSave === false) {
    throw new Error('you do not have permission to save this dashboard; propose a new dashboard (copy) instead');
  }
  const json = JSON.parse(JSON.stringify(original));
  json.panels = json.panels ?? [];
  const all = ctx.listDataSources();
  const changes: string[] = [];
  const warnings: string[] = [];
  const checkSpecs: PanelSpec[] = [];

  // removals
  for (const id of input.remove_panel_ids ?? []) {
    let removed = false;
    const strip = (ps: any[]): any[] =>
      ps.filter((p) => {
        if (p.id === id) {
          removed = true;
          changes.push(`− remove panel [${id}] "${p.title ?? ''}"`);
          return false;
        }
        if (p.panels) {
          p.panels = strip(p.panels);
        }
        return true;
      });
    json.panels = strip(json.panels);
    if (!removed) {
      warnings.push(`panel ${id} not found (remove)`);
    }
  }

  // updates
  for (const patch of input.update_panels ?? []) {
    let found: any;
    walkPanels(json.panels, (p) => {
      if (p.id === patch.panel_id) {
        found = p;
      }
    });
    if (!found) {
      warnings.push(`panel ${patch.panel_id} not found (update)`);
      continue;
    }
    const what: string[] = [];
    if (patch.title !== undefined && patch.title !== found.title) {
      what.push(`title "${found.title}" → "${patch.title}"`);
      found.title = patch.title;
    }
    if (patch.description !== undefined) {
      found.description = patch.description;
      what.push('description');
    }
    if (patch.type && patch.type !== found.type) {
      const rebuilt = buildPanel({ ...(patch as PanelSpec), title: found.title, type: patch.type, queries: patch.queries ?? [] }, found.id, all, warnings);
      what.push(`type ${found.type} → ${rebuilt.type}`);
      found.type = rebuilt.type;
      found.options = rebuilt.options;
      found.fieldConfig = { ...rebuilt.fieldConfig, defaults: { ...rebuilt.fieldConfig.defaults, ...(found.fieldConfig?.defaults?.unit ? { unit: found.fieldConfig.defaults.unit } : {}) } };
    }
    found.fieldConfig = found.fieldConfig ?? { defaults: {}, overrides: [] };
    found.fieldConfig.defaults = found.fieldConfig.defaults ?? {};
    if (patch.unit !== undefined) {
      what.push(`unit ${found.fieldConfig.defaults.unit ?? '(none)'} → ${patch.unit}`);
      found.fieldConfig.defaults.unit = patch.unit;
    }
    if (patch.thresholds?.length) {
      found.fieldConfig.defaults.thresholds = { mode: 'absolute', steps: patch.thresholds.map((t, i) => ({ color: t.color, value: i === 0 ? null : t.value })) };
      what.push('thresholds');
    }
    if (patch.width || patch.height) {
      found.gridPos = { ...found.gridPos, w: patch.width ?? found.gridPos?.w, h: patch.height ?? found.gridPos?.h };
      what.push('size');
    }
    if (patch.queries?.length) {
      let dsRef = found.datasource;
      if (patch.datasource_uid) {
        const ds = all.find((d) => d.uid === patch.datasource_uid || d.name === patch.datasource_uid);
        dsRef = ds ? { uid: ds.uid, type: ds.type } : { uid: patch.datasource_uid };
        found.datasource = dsRef;
      }
      const before = (found.targets ?? []).map((t: any) => t.expr ?? t.query).join(' ; ');
      found.targets = buildTargets({ ...(patch as PanelSpec), title: found.title, type: (patch.type ?? found.type) as any }, typeof dsRef === 'string' ? { uid: dsRef } : dsRef);
      what.push(`queries: ${before.slice(0, 120)} → ${found.targets.map((t: any) => t.expr ?? t.query).join(' ; ').slice(0, 160)}`);
      checkSpecs.push({ title: found.title, type: (patch.type ?? 'timeseries') as any, datasource_uid: dsRef?.uid, queries: patch.queries });
    }
    changes.push(`~ update panel [${found.id}] "${found.title}": ${what.join('; ') || 'no effective change'}`);
  }

  // additions
  if (input.add_panels?.length) {
    let maxId = 0;
    let bottom = 0;
    walkPanels(json.panels, (p) => {
      maxId = Math.max(maxId, Number(p.id) || 0);
      if (p.gridPos) {
        bottom = Math.max(bottom, (p.gridPos.y ?? 0) + (p.gridPos.h ?? 0));
      }
    });
    const nextId = () => ++maxId;
    const built = input.add_panels.map((spec) => ({ spec, json: buildPanel(spec, nextId(), all, warnings) }));
    const { panels } = layout(built, bottom, nextId);
    json.panels.push(...panels);
    panels.forEach((p) => changes.push(`+ add ${p.type === 'row' ? 'row' : 'panel'} "${p.title}"${p.type !== 'row' ? ` (${p.type})` : ''}`));
    checkSpecs.push(...input.add_panels);
  }

  for (const v of input.add_variables ?? []) {
    json.templating = json.templating ?? { list: [] };
    if (json.templating.list.some((x: any) => x.name === v.name)) {
      warnings.push(`variable $${v.name} already exists`);
      continue;
    }
    json.templating.list.push(buildVariable(v, all, warnings));
    changes.push(`+ add variable $${v.name}`);
  }

  for (const a of input.add_annotations ?? []) {
    json.annotations = json.annotations ?? { list: [] };
    if (json.annotations.list.some((x: any) => x.name === a.name)) {
      warnings.push(`annotation "${a.name}" already exists`);
      continue;
    }
    json.annotations.list.push(buildAnnotation(a, all, warnings));
    changes.push(`+ add annotation "${a.name}"`);
  }

  if (input.set) {
    const s = input.set;
    if (s.title) {
      changes.push(`~ title "${json.title}" → "${s.title}"`);
      json.title = s.title;
    }
    if (s.description !== undefined) {
      json.description = s.description;
      changes.push('~ description');
    }
    if (s.tags) {
      json.tags = s.tags;
      changes.push(`~ tags ${s.tags.join(',')}`);
    }
    if (s.time_from) {
      json.time = { from: s.time_from, to: 'now' };
      changes.push(`~ default time ${s.time_from}`);
    }
    if (s.refresh !== undefined) {
      json.refresh = s.refresh;
      changes.push(`~ refresh ${s.refresh || 'off'}`);
    }
  }

  if (!changes.length) {
    throw new Error('no changes requested');
  }
  const checks = checkSpecs.length ? await checkQueries(ctx, checkSpecs, all, new Map()) : [];
  return {
    kind: 'dashboard_edit',
    id: proposalId(),
    dashboardUid: original.uid,
    title: json.title,
    folderUid: resp.meta?.folderUid,
    baseVersion: original.version,
    json,
    changes,
    warnings,
    checks,
    url: resp.meta?.url ?? dashboardUrl(original.uid),
  };
}

export const proposeDashboardEdit: ToolDefinition = {
  schema: {
    name: 'propose_dashboard_edit',
    description:
      'Propose changes to an EXISTING dashboard (add/update/remove panels, add variables, change title/tags/time). Read it first with get_dashboard for panel ids. The user sees a change list and clicks Apply; Grafana saves a new version (restorable from version history) and rejects the save if someone changed the dashboard meanwhile. New/changed queries are dry-run.',
    input_schema: {
      type: 'object',
      properties: {
        dashboard_uid: { type: 'string' },
        summary: { type: 'string', description: 'One line describing the change, used as the version message' },
        add_panels: { type: 'array', items: { type: 'object', description: 'Same shape as draft_dashboard panels' } },
        update_panels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              panel_id: { type: 'number' },
              title: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string' },
              unit: { type: 'string' },
              datasource_uid: { type: 'string' },
              queries: { type: 'array', items: { type: 'object' } },
              thresholds: { type: 'array', items: { type: 'object' } },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['panel_id'],
          },
        },
        remove_panel_ids: { type: 'array', items: { type: 'number' } },
        add_variables: { type: 'array', items: { type: 'object' } },
        add_annotations: { type: 'array', items: annotationSchema },
        set: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, time_from: { type: 'string' }, refresh: { type: 'string' } } },
      },
      required: ['dashboard_uid'],
    },
  },
  describe: (i) => `Propose edit to ${i.dashboard_uid}`,
  run: async (input, ctx) => {
    const p = await buildDashboardEdit(input as EditInput, ctx);
    (p as any).summary = input.summary;
    requirePropose(ctx)(p);
    const bad = p.checks.filter((c) => c.status === 'error' || c.status === 'empty');
    return [
      `Edit proposal for "${p.title}" shown to the user (Apply / Discard). Not applied yet.`,
      ...p.changes,
      p.warnings.length ? `Warnings: ${p.warnings.join('; ')}` : '',
      bad.length ? `Queries needing attention:\n${bad.map((c) => `- [${c.status}] ${c.panel}: ${c.detail}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
};

// ---------------------------------------------------------------- alerting

const amBase = '/api/alertmanager/grafana/api/v2';

export const listSilences: ToolDefinition = {
  schema: {
    name: 'list_silences',
    description: 'List active and pending silences in the Grafana Alertmanager (matchers, creator, comment, end time).',
    input_schema: { type: 'object', properties: { include_expired: { type: 'boolean' } } },
  },
  describe: () => 'List silences',
  run: async (input, ctx) => {
    const list = await ctx.http.get<any[]>(`${amBase}/silences`, undefined, ctx.signal);
    const rows = (list ?? [])
      .filter((s) => input.include_expired || s.status?.state !== 'expired')
      .map(
        (s) =>
          `${s.id} [${s.status?.state}] ${s.matchers.map((m: any) => `${m.name}${m.isEqual === false ? '!' : ''}${m.isRegex ? '=~' : '='}"${m.value}"`).join(', ')} until ${s.endsAt} by ${s.createdBy}: ${s.comment}`
      );
    return rows.length ? rows.join('\n') : 'No silences.';
  },
};

function parseMatcher(m: any) {
  const op = String(m.op ?? '=');
  return { name: String(m.name), value: String(m.value), isRegex: op.includes('~'), isEqual: !op.startsWith('!') };
}

export const draftSilence: ToolDefinition = {
  schema: {
    name: 'draft_silence',
    description:
      'Prepare a silence for alerts matching label matchers. Shown to the user with the alerts it would silence right now; created only if the user clicks Create. Keep matchers as specific as possible.',
    input_schema: {
      type: 'object',
      properties: {
        matchers: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' }, op: { type: 'string', enum: ['=', '!=', '=~', '!~'] } }, required: ['name', 'value'] },
        },
        duration: { type: 'string', description: 'e.g. 30m, 2h (max 7d)' },
        comment: { type: 'string', description: 'Why, and link to the investigation/incident' },
      },
      required: ['matchers', 'duration', 'comment'],
    },
  },
  describe: (i) => `Draft silence (${(i.matchers ?? []).map((m: any) => `${m.name}${m.op ?? '='}${m.value}`).join(', ')})`,
  run: async (input, ctx) => {
    const matchers = (input.matchers ?? []).map(parseMatcher);
    if (!matchers.length) {
      throw new Error('at least one matcher is required');
    }
    const secs = parseDurationSeconds(input.duration) ?? 3600;
    if (secs > 7 * 86400) {
      throw new Error('silences longer than 7 days are not allowed');
    }
    const filter = matchers.map((m: any) => `${m.name}${m.isEqual ? '' : '!'}${m.isRegex ? '=~' : '='}"${m.value}"`);
    let matching: string[] = [];
    try {
      const alerts = await ctx.http.get<any[]>(`${amBase}/alerts`, { filter, active: true, silenced: false, inhibited: false }, ctx.signal);
      matching = (alerts ?? []).map((a) => `${a.labels?.alertname ?? '?'} ${JSON.stringify(a.labels)}`).slice(0, 50);
    } catch {
      matching = [];
    }
    const now = ctx.now();
    const p: SilenceProposal = {
      kind: 'silence',
      id: proposalId(),
      matchers,
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(now + secs * 1000).toISOString(),
      comment: String(input.comment ?? ''),
      matchingAlerts: matching,
    };
    requirePropose(ctx)(p);
    return `Silence proposal shown to the user (not created). It would currently silence ${matching.length} firing alert(s)${matching.length ? ':\n' + matching.slice(0, 15).join('\n') : '. Check the matchers if you expected matches.'}`;
  },
};

const OPS: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };

export const draftAlertRule: ToolDefinition = {
  schema: {
    name: 'draft_alert_rule',
    description:
      'Prepare a Grafana-managed alert rule (PromQL or LogQL metric query + threshold). The query is evaluated now so the user sees whether it would fire. Created only when the user clicks Create, in the chosen folder and evaluation group. Prefer ratio/rate expressions with explicit windows and a for-duration to avoid flapping.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        folder_uid: { type: 'string', description: 'From list_folders' },
        group: { type: 'string', description: 'Evaluation group name (created if missing)' },
        datasource_uid: { type: 'string' },
        expr: { type: 'string' },
        operator: { type: 'string', enum: ['gt', 'lt', 'gte', 'lte'] },
        threshold: { type: 'number' },
        for: { type: 'string', description: 'Pending period, e.g. 5m' },
        labels: { type: 'object', additionalProperties: { type: 'string' } },
        summary: { type: 'string' },
        description: { type: 'string' },
        runbook_url: { type: 'string' },
      },
      required: ['title', 'folder_uid', 'group', 'datasource_uid', 'expr', 'operator', 'threshold'],
    },
  },
  describe: (i) => `Draft alert rule "${i.title}"`,
  run: async (input, ctx) => {
    const ds = findDataSource(ctx, input.datasource_uid, [...PROM_TYPES, ...LOKI_TYPES]);
    const op = OPS[input.operator] ? input.operator : 'gt';
    const isLoki = ds.type === 'loki';
    const model = isLoki
      ? { refId: 'A', expr: input.expr, queryType: 'instant' }
      : { refId: 'A', expr: input.expr, instant: true, range: false };
    const evaluator = op === 'gte' || op === 'lte' ? { type: op === 'gte' ? 'gt' : 'lt', params: [Number(input.threshold)] } : { type: op, params: [Number(input.threshold)] };
    const rule = {
      title: input.title,
      ruleGroup: input.group,
      folderUID: input.folder_uid,
      condition: 'C',
      for: input.for ?? '5m',
      noDataState: 'NoData',
      execErrState: 'Error',
      labels: input.labels ?? {},
      annotations: {
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.runbook_url ? { runbook_url: input.runbook_url } : {}),
      },
      data: [
        { refId: 'A', relativeTimeRange: { from: 600, to: 0 }, datasourceUid: ds.uid, model },
        { refId: 'B', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: '__expr__', model: { refId: 'B', type: 'reduce', expression: 'A', reducer: 'last' } },
        { refId: 'C', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: '__expr__', model: { refId: 'C', type: 'threshold', expression: 'B', conditions: [{ evaluator }] } },
      ],
    };
    let preview = '';
    try {
      const now = ctx.now();
      const resp = await dsQuery(ctx, ds, isLoki ? { expr: input.expr, queryType: 'instant' } : { expr: input.expr, instant: true, range: false }, { from: now - 600_000, to: now });
      preview = summarizeTimeSeries(framesOf(resp), { samples: 1 });
    } catch (e: any) {
      preview = `Query failed: ${e?.message ?? e}`;
    }
    const p: AlertRuleProposal = {
      kind: 'alert_rule',
      id: proposalId(),
      rule,
      summary: [
        `${input.title}`,
        `when ${input.expr} ${OPS[op]} ${input.threshold} for ${rule.for}`,
        `folder ${input.folder_uid}, group "${input.group}"`,
      ],
      preview,
    };
    requirePropose(ctx)(p);
    return `Alert rule proposal shown to the user (not created). Current evaluation:\n${preview}`;
  },
};

// ---------------------------------------------------------------- profiles

const PYRO = (t: string) => t.includes('pyroscope');

export const queryProfiles: ToolDefinition = {
  schema: {
    name: 'query_profiles',
    description:
      "Query continuous profiles (Pyroscope) for a service and return the hottest functions by self and total time. Use to explain CPU/memory regressions down to code. Call without profile_type first to list available profile types.",
    input_schema: {
      type: 'object',
      properties: {
        datasource_uid: { type: 'string' },
        profile_type: { type: 'string', description: 'e.g. process_cpu:cpu:nanoseconds:cpu:nanoseconds, memory:alloc_space:bytes:space:bytes' },
        label_selector: { type: 'string', description: 'e.g. {service_name="checkout"}' },
        start: { type: 'string' },
        end: { type: 'string' },
      },
      required: ['datasource_uid'],
    },
  },
  describe: (i) => `Profiles ${i.profile_type ?? '(types)'} ${i.label_selector ?? ''}`,
  run: async (input, ctx: ToolContext) => {
    const ds: DataSourceInfo = findDataSource(ctx, input.datasource_uid);
    if (!PYRO(ds.type)) {
      throw new Error(`datasource ${ds.name} is ${ds.type}, not Pyroscope`);
    }
    if (!input.profile_type) {
      const types = await dsResource<Array<{ id: string; label: string }>>(ctx, ds, 'profileTypes');
      return (types ?? []).map((t) => `${t.id} — ${t.label}`).join('\n') || 'No profile types.';
    }
    const range = resolveRange(input, ctx.timeRange, ctx.now());
    const resp = await dsQuery(ctx, ds, { queryType: 'profile', profileTypeId: input.profile_type, labelSelector: input.label_selector ?? '{}', groupBy: [] }, range);
    const frames = framesOf(resp);
    const fg = frames.find((f) => (f.schema?.fields ?? []).some((x) => x.name === 'self'));
    if (!fg) {
      return 'No profile data.';
    }
    const fields = fg.schema!.fields;
    const col = (n: string) => (fg.data?.values[fields.findIndex((x) => x.name === n)] ?? []) as any[];
    const labelField: any = fields.find((x) => x.name === 'label');
    const enumText: string[] | undefined = labelField?.config?.type?.enum?.text;
    const labels = col('label').map((v) => (enumText && typeof v === 'number' ? enumText[v] : String(v)));
    const value = col('value') as number[];
    const self = col('self') as number[];
    const totals = new Map<string, { total: number; self: number }>();
    labels.forEach((l, i) => {
      const e = totals.get(l) ?? { total: 0, self: 0 };
      e.total += value[i] ?? 0;
      e.self += self[i] ?? 0;
      totals.set(l, e);
    });
    const root = value[0] || 1;
    const top = [...totals.entries()].filter(([l]) => l !== 'total').sort((a, b) => b[1].self - a[1].self).slice(0, 25);
    return clip(
      [
        `${input.profile_type} ${input.label_selector ?? ''} ${iso(range.from)} → ${iso(range.to)} (root total ${root})`,
        'Top functions by self (self% / total%):',
        ...top.map(([l, v]) => `- ${((100 * v.self) / root).toFixed(1)}% / ${((100 * v.total) / root).toFixed(1)}%  ${l}`),
      ].join('\n')
    );
  },
};

export const actionTools = [proposeDashboardEdit, listSilences, draftSilence, draftAlertRule];
