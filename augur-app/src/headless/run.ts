/**
 * Augur headless runner: the same agent, tools and prompts as the Grafana app, driven from Node.
 *
 * Used for end-to-end tests against a real Grafana and for benchmarks (o11y-bench). It talks to
 * Grafana's HTTP API with a service-account token (or basic auth) instead of a browser session.
 *
 * Model access, one of:
 *   AUGUR_DATASOURCE_UID   call the model through the Augur (Claude) datasource in that Grafana
 *   MODEL_BASE_URL         call a Claude Messages API directly (Anthropic, LiteLLM /v1/messages, …)
 *
 * Proposals (dashboards, edits, silences, alert rules) are NOT applied unless AUGUR_APPLY=auto.
 * Automatic apply exists for unattended benchmarks and tests; it is not how the app behaves.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runAgent } from '../agent/runner';
import { buildToolset } from '../agent/tools';
import { buildSystemPrompt, conclusionGate, stateReminder } from '../agent/prompts';
import { applyProposal } from '../agent/apply';
import { STEP_BUDGET } from '../constants';
import { DEFAULT_MAX_TOKENS_PER_RUN, effectiveTokens } from '../settings';
import type { AgentEvent, AgentMode, DataSourceInfo, EvidenceRecord, Finding, GrafanaHttp, Hypothesis, Message, MessagesRequest, MessagesResponse, ModelCaller, ToolDefinition, Usage } from '../agent/types';
import type { Proposal } from '../agent/proposals';

export interface HeadlessConfig {
  grafanaUrl: string;
  grafanaToken?: string;
  grafanaUser?: string;
  grafanaPassword?: string;
  orgId?: string;
  datasourceUid?: string;
  modelBaseUrl?: string;
  modelApiKey?: string;
  modelAuthHeader?: 'x-api-key' | 'authorization';
  model?: string;
  maxTokens: number;
  mode: AgentMode;
  subAgents: boolean;
  apply: 'auto' | 'off';
  folderUid?: string;
  now: number;
  rangeMs: number;
  maxSteps: number;
  maxTokensPerRun: number;
  prompt: string;
  trajectoryPath?: string;
  answerPath?: string;
  quiet: boolean;
}

const RETRYABLE = new Set([0, 408, 425, 429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [2000, 5000, 10000, 20000, 40000];

export class HttpError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public data: unknown
  ) {
    super(`HTTP ${status}${statusText ? ' ' + statusText : ''}`);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

function query(params?: Record<string, unknown>): string {
  if (!params) {
    return '';
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') {
      continue;
    }
    for (const item of Array.isArray(v) ? v : [v]) {
      q.append(k, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Grafana HTTP API client with the same error shape as Grafana's backendSrv (status + data). */
export function grafanaClient(cfg: Pick<HeadlessConfig, 'grafanaUrl' | 'grafanaToken' | 'grafanaUser' | 'grafanaPassword' | 'orgId'>): GrafanaHttp {
  const base = cfg.grafanaUrl.replace(/\/+$/, '');
  // Service-account token, else basic auth, else anonymous (e.g. a test Grafana with anonymous admin).
  const auth = cfg.grafanaToken
    ? `Bearer ${cfg.grafanaToken}`
    : cfg.grafanaUser
      ? `Basic ${Buffer.from(`${cfg.grafanaUser}:${cfg.grafanaPassword ?? ''}`).toString('base64')}`
      : undefined;
  const send = async <T>(method: string, url: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, params?: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${base}${url}${query(params)}`, {
      method,
      signal,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cfg.orgId ? { 'X-Grafana-Org-Id': cfg.orgId } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text
    }
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText, typeof data === 'string' ? { message: data.slice(0, 500) } : data);
    }
    return data as T;
  };
  return {
    get: (url, params, signal) => send('GET', url, undefined, signal, undefined, params),
    post: (url, body, signal, headers) => send('POST', url, body, signal, headers),
    put: (url, body, signal) => send('PUT', url, body, signal),
  };
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, log: (s: string) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e instanceof HttpError ? e.status : signal.aborted ? -1 : 0;
      const msg = JSON.stringify((e as HttpError).data ?? (e as Error).message ?? '');
      if (status >= 0 && RETRYABLE.has(status) && attempt < BACKOFF_MS.length && !/prompt is too long/i.test(msg)) {
        const ms = Math.round(BACKOFF_MS[attempt] * (0.5 + Math.random()));
        log(`model call failed (${status || 'network'}); retrying in ${ms}ms`);
        await sleep(ms, signal);
        continue;
      }
      if (e instanceof HttpError) {
        const d = e.data as any;
        throw new Error(`HTTP ${e.status}: ${d?.error?.message ?? d?.message ?? JSON.stringify(d).slice(0, 300)}`);
      }
      throw e;
    }
  }
}

export function modelCaller(cfg: HeadlessConfig, http: GrafanaHttp, log: (s: string) => void): ModelCaller {
  if (cfg.datasourceUid) {
    const path = `/api/datasources/uid/${encodeURIComponent(cfg.datasourceUid)}/resources/messages`;
    return (req, signal) => withRetry(() => http.post<MessagesResponse>(path, req, signal), signal, log);
  }
  if (!cfg.modelBaseUrl) {
    throw new Error('Set AUGUR_DATASOURCE_UID or MODEL_BASE_URL');
  }
  const url = /\/messages$/.test(cfg.modelBaseUrl) ? cfg.modelBaseUrl : `${cfg.modelBaseUrl.replace(/\/+$/, '')}/v1/messages`;
  const header = cfg.modelAuthHeader ?? (/anthropic\.com/.test(url) ? 'x-api-key' : 'authorization');
  return (req: MessagesRequest, signal: AbortSignal) =>
    withRetry(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(cfg.modelApiKey ? (header === 'x-api-key' ? { 'x-api-key': cfg.modelApiKey } : { Authorization: `Bearer ${cfg.modelApiKey}` }) : {}),
          },
          body: JSON.stringify({ ...req, model: req.model ?? cfg.model, max_tokens: req.max_tokens ?? cfg.maxTokens }),
        });
        const text = await res.text();
        let data: any = text;
        try {
          data = JSON.parse(text);
        } catch {
          // keep text
        }
        if (!res.ok) {
          throw new HttpError(res.status, res.statusText, data);
        }
        return data as MessagesResponse;
      },
      signal,
      log
    );
}

interface AtifStep {
  step_id: number;
  timestamp: string;
  source: 'system' | 'user' | 'agent';
  message: string;
  tool_calls?: Array<{ tool_call_id: string; function_name: string; arguments: Record<string, unknown> }>;
  observation?: { results: Array<{ source_call_id: string; content: string; extra?: { is_error: boolean } }> };
  metrics?: { prompt_tokens: number; completion_tokens: number; cached_tokens: number };
}

export interface HeadlessResult {
  answer: string;
  stopReason: string;
  usage: Required<Usage>;
  evidence: EvidenceRecord[];
  findings: Finding[];
  hypotheses: Hypothesis[];
  applied: Array<{ kind: string; message: string; url?: string; error?: string }>;
  trajectory: Record<string, unknown>;
}

export async function runHeadless(cfg: HeadlessConfig, opts: { call?: ModelCaller; http?: GrafanaHttp; log?: (s: string) => void } = {}): Promise<HeadlessResult> {
  const log = opts.log ?? ((s: string) => (cfg.quiet ? undefined : process.stderr.write(`${s}\n`)));
  const http = opts.http ?? grafanaClient(cfg);
  const ac = new AbortController();

  const [dsList, user, health] = await Promise.all([
    http.get<Array<{ uid: string; name: string; type: string; isDefault?: boolean }>>('/api/datasources'),
    http.get<{ login?: string }>('/api/user').catch(() => ({ login: undefined })),
    http.get<{ version?: string }>('/api/health').catch(() => ({ version: undefined })),
  ]);
  const datasources: DataSourceInfo[] = dsList.map((d) => ({ uid: d.uid, name: d.name, type: d.type, isDefault: d.isDefault }));

  // Lead-agent model calls are recorded for the trajectory; sub-agent calls only count usage.
  const usage: Required<Usage> = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const addUsage = (u?: Usage) => {
    if (u) {
      usage.input_tokens = (usage.input_tokens ?? 0) + (u.input_tokens ?? 0);
      usage.output_tokens = (usage.output_tokens ?? 0) + (u.output_tokens ?? 0);
      usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
  };
  const base = opts.call ?? modelCaller(cfg, http, log);
  const responses: MessagesResponse[] = [];
  const subCall: ModelCaller = async (req, signal) => {
    const r = await base({ ...req, model: req.model ?? cfg.model }, signal);
    addUsage(r.usage);
    return r;
  };
  const leadCall: ModelCaller = async (req, signal) => {
    const r = await subCall(req, signal);
    responses.push(r);
    return r;
  };

  const evidence: EvidenceRecord[] = [];
  const findings: Finding[] = [];
  let hypotheses: Hypothesis[] = [];
  const applied: HeadlessResult['applied'] = [];
  const toolOutputs = new Map<string, { output: string; ok: boolean }>();

  // Auto-apply: each proposal is applied right away, and the outcome is appended to the output of
  // the tool call that produced it so the model sees failures (as a user would).
  let pending: Array<Promise<string>> = [];
  const propose =
    cfg.apply === 'auto'
      ? (p: Proposal) => {
          pending.push(
            applyProposal(http, p, { folderUid: cfg.folderUid, login: user.login ?? 'augur-headless' }).then(
              (r) => (applied.push({ kind: p.kind, message: r.message, url: r.url }), `[applied automatically: ${r.message} → ${r.url}]`),
              (e) => {
                const d = (e as HttpError).data as any;
                const msg = d?.message ?? (e as Error).message;
                applied.push({ kind: p.kind, message: 'apply failed', error: msg });
                return `[automatic apply FAILED: ${msg}]`;
              }
            )
          );
        }
      : undefined;
  const settleApplies = (tools: ToolDefinition[]): ToolDefinition[] =>
    tools.map((t) => ({
      ...t,
      run: async (input, ctx) => {
        const out = await t.run(input, ctx);
        if (!pending.length) {
          return out;
        }
        const notes = await Promise.all(pending);
        pending = [];
        return `${out}\n${notes.join('\n')}`;
      },
    }));

  const now = cfg.now;
  const range = { from: now - cfg.rangeMs, to: now };
  const promptBase = { now, range, datasources, user: { login: user.login }, grafanaVersion: health.version, timezone: 'UTC' };
  const onEvent = (e: AgentEvent) => {
    if (e.kind === 'tool_start') {
      log(`${e.agent ? `  [${e.agent}] ` : ''}→ ${e.name} ${JSON.stringify(e.input).slice(0, 160)}`);
    } else if (e.kind === 'tool_end') {
      if (!e.agent) {
        toolOutputs.set(e.id, { output: e.output, ok: e.ok });
      }
      log(`${e.agent ? `  [${e.agent}] ` : ''}${e.ok ? '✓' : '✗'} ${e.name} (${e.ms}ms, ${e.output.length} chars)`);
    } else if (e.kind === 'status' || e.kind === 'error') {
      log(`· ${e.text}`);
    }
  };
  const subAgents = cfg.mode === 'investigate' && cfg.subAgents;
  const UNATTENDED =
    '\nThis run is unattended: nobody will answer questions or click Apply. Act autonomously; proposals you make (dashboards, edits, silences, alert rules) are applied automatically and the outcome is appended to the tool result.';
  const system = buildSystemPrompt({ ...promptBase, mode: cfg.mode, subAgents }) + (cfg.apply === 'auto' ? UNATTENDED : '');
  const tools = settleApplies(
    buildToolset(cfg.mode, {
      propose,
      skills: [],
      mcp: [],
      delegate: subAgents ? { call: subCall, model: cfg.model, maxTokens: cfg.maxTokens, baseSystem: buildSystemPrompt({ ...promptBase, mode: 'chat' }), onEvent } : undefined,
    })
  );

  let stopReason = 'end_turn';
  const messages: Message[] = [{ role: 'user', content: cfg.prompt }];
  const final = await runAgent({
    call: leadCall,
    tools,
    system,
    messages,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    maxSteps: cfg.maxSteps,
    onEvent: (e) => {
      if (e.kind === 'done') {
        stopReason = e.stopReason;
      }
      onEvent(e);
    },
    beforeFinish: cfg.mode === 'investigate' ? () => conclusionGate(hypotheses) : undefined,
    afterTools: cfg.mode === 'investigate' ? stateReminder() : undefined,
    budgetExceeded: () => {
      const used = effectiveTokens(usage);
      return used > cfg.maxTokensPerRun ? `Token budget for this run is used up (${Math.round(used / 1000)}k of ${Math.round(cfg.maxTokensPerRun / 1000)}k).` : undefined;
    },
    ctx: {
      http,
      listDataSources: () => datasources,
      timeRange: range,
      now: () => now,
      signal: ac.signal,
      propose,
      confirm: async () => cfg.apply === 'auto',
      recordEvidence: (e) => {
        const id = `E${evidence.length + 1}`;
        evidence.push({ ...e, id });
        return id;
      },
      recordFinding: (f) => findings.push(f),
      updateHypothesis: (h) => {
        hypotheses = [...hypotheses.filter((x) => x.id !== h.id), h];
      },
    },
  });

  const lastAssistant = [...final].reverse().find((m) => m.role === 'assistant');
  const answer =
    typeof lastAssistant?.content === 'string'
      ? lastAssistant.content
      : (lastAssistant?.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim();

  // ATIF-v1.7 trajectory (the format o11y-bench grades).
  const steps: AtifStep[] = [];
  const ts = () => new Date().toISOString();
  steps.push({ step_id: 1, timestamp: ts(), source: 'system', message: system });
  steps.push({ step_id: 2, timestamp: ts(), source: 'user', message: cfg.prompt });
  for (const r of responses) {
    const text = r.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
    const calls = r.content.filter((b) => b.type === 'tool_use') as Array<{ id: string; name: string; input: Record<string, unknown> }>;
    const step: AtifStep = {
      step_id: steps.length + 1,
      timestamp: ts(),
      source: 'agent',
      message: text,
      metrics: { prompt_tokens: r.usage?.input_tokens ?? 0, completion_tokens: r.usage?.output_tokens ?? 0, cached_tokens: r.usage?.cache_read_input_tokens ?? 0 },
    };
    if (calls.length) {
      step.tool_calls = calls.map((c) => ({ tool_call_id: c.id, function_name: c.name, arguments: c.input }));
      step.observation = {
        results: calls.map((c) => {
          const o = toolOutputs.get(c.id);
          return { source_call_id: c.id, content: o?.output ?? '', ...(o && !o.ok ? { extra: { is_error: true } } : {}) };
        }),
      };
    }
    steps.push(step);
  }
  const trajectory = {
    schema_version: 'ATIF-v1.7',
    session_id: `augur-${now}`,
    trajectory_id: `augur-${Math.random().toString(36).slice(2)}`,
    agent: { name: 'augur', version: process.env.AUGUR_VERSION ?? 'dev', model_name: cfg.model ?? '', tool_definitions: tools.map((t) => t.schema) },
    steps,
    final_metrics: {
      total_prompt_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      total_completion_tokens: usage.output_tokens ?? 0,
      total_cached_tokens: usage.cache_read_input_tokens ?? 0,
      total_steps: steps.length,
      extra: { mode: cfg.mode, stop_reason: stopReason, evidence: evidence.length, findings: findings.length, applied },
    },
  };
  if (cfg.trajectoryPath) {
    mkdirSync(dirname(cfg.trajectoryPath), { recursive: true });
    writeFileSync(cfg.trajectoryPath, JSON.stringify(trajectory, null, 2));
  }
  if (cfg.answerPath) {
    mkdirSync(dirname(cfg.answerPath), { recursive: true });
    writeFileSync(cfg.answerPath, answer);
  }
  return { answer, stopReason, usage, evidence, findings, hypotheses, applied, trajectory };
}

export function configFromEnv(env: NodeJS.ProcessEnv, argv: string[]): HeadlessConfig {
  const promptFile = env.AUGUR_PROMPT_FILE;
  const prompt = argv.join(' ').trim() || (promptFile ? readFileSync(promptFile, 'utf8') : '') || env.AUGUR_PROMPT || '';
  if (!prompt) {
    throw new Error('Give a prompt as arguments, AUGUR_PROMPT or AUGUR_PROMPT_FILE');
  }
  const mode = (env.AUGUR_MODE ?? 'chat') as AgentMode;
  if (mode !== 'chat' && mode !== 'investigate') {
    throw new Error('AUGUR_MODE must be chat or investigate');
  }
  const nowIso = env.AUGUR_NOW ?? env.O11Y_SCENARIO_TIME_ISO;
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  if (Number.isNaN(now)) {
    throw new Error(`invalid AUGUR_NOW: ${nowIso}`);
  }
  return {
    grafanaUrl: env.GRAFANA_URL ?? 'http://localhost:3000',
    grafanaToken: env.GRAFANA_TOKEN || env.GRAFANA_SERVICE_ACCOUNT_TOKEN || undefined,
    grafanaUser: env.GRAFANA_USER,
    grafanaPassword: env.GRAFANA_PASSWORD,
    orgId: env.GRAFANA_ORG_ID,
    datasourceUid: env.AUGUR_DATASOURCE_UID || undefined,
    modelBaseUrl: env.MODEL_BASE_URL || env.ANTHROPIC_BASE_URL || undefined,
    modelApiKey: env.MODEL_API_KEY || env.ANTHROPIC_API_KEY || undefined,
    modelAuthHeader: env.MODEL_AUTH_HEADER === 'x-api-key' || env.MODEL_AUTH_HEADER === 'authorization' ? env.MODEL_AUTH_HEADER : undefined,
    model: env.MODEL || env.AUGUR_MODEL || undefined,
    maxTokens: Number(env.AUGUR_MAX_TOKENS ?? 8192),
    mode,
    subAgents: env.AUGUR_SUBAGENTS !== '0',
    apply: env.AUGUR_APPLY === 'auto' ? 'auto' : 'off',
    folderUid: env.AUGUR_FOLDER_UID || undefined,
    now,
    rangeMs: Number(env.AUGUR_RANGE_MINUTES ?? 60) * 60_000,
    maxSteps: Number(env.AUGUR_MAX_STEPS ?? STEP_BUDGET[mode]),
    maxTokensPerRun: Number(env.AUGUR_MAX_TOKENS_PER_RUN ?? DEFAULT_MAX_TOKENS_PER_RUN),
    prompt,
    trajectoryPath: env.AUGUR_TRAJECTORY || undefined,
    answerPath: env.AUGUR_ANSWER || undefined,
    quiet: env.AUGUR_QUIET === '1',
  };
}
