import {
  AgentEvent,
  ContentBlock,
  Message,
  MessagesRequest,
  ModelCaller,
  TextBlock,
  ToolContext,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from './types';
import { clip } from './frames';
import { errorMessage } from './grafana';

export interface RunOptions {
  call: ModelCaller;
  tools: ToolDefinition[];
  system: string;
  /** Conversation so far; the new user turn must already be appended. */
  messages: Message[];
  ctx: ToolContext;
  onEvent: (e: AgentEvent) => void;
  maxSteps: number;
  model?: string;
  maxTokens?: number;
  /** Approximate token budget for the request before older content is compacted (default 140k). */
  contextTokenBudget?: number;
  /** Called after every model response and every batch of tool results (checkpointing). */
  onProgress?: (messages: Message[]) => void;
  toolConcurrency?: number;
  /**
   * Called when the model wants to stop. Returning text sends it as a user nudge and continues the
   * loop once (used as the investigation "conclusion gate").
   */
  beforeFinish?: () => string | undefined;
  /** Optional nudge appended to a batch of tool results (e.g. investigation state reminders). */
  afterTools?: (toolNames: string[]) => string | undefined;
  /** Returns a reason when the run's token budget is exhausted; the loop then finishes up. */
  budgetExceeded?: () => string | undefined;
}

/** Runs the tool-use loop until the model stops calling tools. Returns the updated conversation. */
export async function runAgent(opts: RunOptions): Promise<Message[]> {
  const { call, tools, ctx, onEvent } = opts;
  const byName = new Map(tools.map((t) => [t.schema.name, t]));
  const messages = [...opts.messages];
  const toolSchemas = tools.map((t) => t.schema);
  let steps = 0;
  let finalCall = false;
  let gated = false;

  while (true) {
    if (ctx.signal.aborted) {
      onEvent({ kind: 'done', stopReason: 'aborted', steps });
      return messages;
    }
    const budget = opts.contextTokenBudget ?? DEFAULT_TOKEN_BUDGET;
    compact(messages, budget, estimateTokens(opts.system) + estimateTokens(toolSchemas));
    onEvent({ kind: 'status', text: steps === 0 ? 'Thinking…' : `Analysing results (step ${steps + 1})…` });

    let resp;
    try {
      try {
        resp = await call(withChoice(buildRequest(opts.system, messages, toolSchemas, opts.model, opts.maxTokens), finalCall), ctx.signal);
      } catch (e) {
        if (!isContextOverflow(e) || ctx.signal.aborted) {
          throw e;
        }
        // The gateway says the prompt is too long: compact hard and retry once.
        onEvent({ kind: 'status', text: 'Context is full; compacting older evidence and retrying…' });
        compact(messages, Math.floor(budget / 2), estimateTokens(opts.system) + estimateTokens(toolSchemas));
        resp = await call(withChoice(buildRequest(opts.system, messages, toolSchemas, opts.model, opts.maxTokens), finalCall), ctx.signal);
      }
    } catch (e) {
      if (ctx.signal.aborted) {
        onEvent({ kind: 'done', stopReason: 'aborted', steps });
        return messages;
      }
      onEvent({ kind: 'error', text: errorMessage(e) });
      onEvent({ kind: 'done', stopReason: 'error', steps });
      return messages;
    }
    steps++;
    if (resp.usage) {
      onEvent({ kind: 'usage', usage: resp.usage });
    }

    const content = (resp.content ?? []) as ContentBlock[];
    messages.push({ role: 'assistant', content });
    opts.onProgress?.(messages);
    for (const b of content) {
      if (b.type === 'text' && (b as TextBlock).text.trim()) {
        onEvent({ kind: 'assistant_text', text: (b as TextBlock).text });
      }
    }

    const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (resp.stop_reason === 'pause_turn') {
      continue;
    }
    if (!toolUses.length && !finalCall && !gated && opts.beforeFinish && resp.stop_reason === 'end_turn') {
      gated = true;
      const nudge = opts.beforeFinish();
      if (nudge) {
        onEvent({ kind: 'status', text: 'Challenging the leading hypothesis before concluding…' });
        messages.push({ role: 'user', content: [{ type: 'text', text: nudge }] });
        opts.onProgress?.(messages);
        continue;
      }
    }
    if (!toolUses.length || finalCall) {
      onEvent({ kind: 'done', stopReason: String(resp.stop_reason ?? 'end_turn'), steps });
      return messages;
    }

    const results = await runTools(toolUses, byName, ctx, onEvent, opts.toolConcurrency ?? 4);
    const userContent: ContentBlock[] = [...results];
    const overBudget = !finalCall ? opts.budgetExceeded?.() : undefined;
    if (overBudget) {
      finalCall = true;
      userContent.push({ type: 'text', text: `${overBudget} Do not call more tools. Give your best answer now from the evidence gathered, and say what you would check next.` });
    }
    const nudge = finalCall ? undefined : opts.afterTools?.(toolUses.map((u) => u.name));
    if (nudge && steps < opts.maxSteps && !finalCall) {
      userContent.push({ type: 'text', text: nudge });
    }
    if (steps >= opts.maxSteps && !finalCall) {
      finalCall = true;
      userContent.push({
        type: 'text',
        text: 'Tool budget for this turn is used up. Do not call more tools. Give your best answer now from the evidence gathered, and say what you would check next.',
      });
    }
    messages.push({ role: 'user', content: userContent });
    opts.onProgress?.(messages);
  }
}

function withChoice(req: MessagesRequest, none: boolean): MessagesRequest {
  return none ? ({ ...req, tool_choice: { type: 'none' } } as MessagesRequest) : req;
}

const CONTEXT_OVERFLOW = /prompt is too long|context(_| )length|context window|maximum context|too many (input )?tokens|input is too long|reduce the length/i;

export function isContextOverflow(e: unknown): boolean {
  const msg = (e as any)?.message ?? String(e);
  return CONTEXT_OVERFLOW.test(msg);
}

async function runTools(
  uses: ToolUseBlock[],
  byName: Map<string, ToolDefinition>,
  ctx: ToolContext,
  onEvent: (e: AgentEvent) => void,
  concurrency: number
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = new Array(uses.length);
  let next = 0;
  const worker = async () => {
    while (next < uses.length) {
      const i = next++;
      const u = uses[i];
      const tool = byName.get(u.name);
      const label = tool?.describe?.(u.input as any) ?? u.name;
      onEvent({ kind: 'tool_start', id: u.id, name: u.name, label, input: u.input, agent: ctx.agent });
      const t0 = Date.now();
      let output: string;
      let ok = true;
      try {
        if (!tool) {
          throw new Error(`unknown tool ${u.name}`);
        }
        // Per-call context: evidence recorded by this call is tagged with it, and its ids are
        // appended to the result so the model can cite them (E#) in findings and the report.
        const ids: string[] = [];
        const callCtx: ToolContext = {
          ...ctx,
          currentTool: { name: u.name, id: u.id },
          recordEvidence: ctx.recordEvidence
            ? (e) => {
                const id = ctx.recordEvidence!(e);
                ids.push(id);
                return id;
              }
            : undefined,
        };
        output = clip(await tool.run((u.input ?? {}) as Record<string, any>, callCtx));
        if (ids.length) {
          output += `\n[evidence ${ids.join(', ')}]`;
        }
      } catch (e) {
        ok = false;
        output = `Error: ${errorMessage(e)}`;
      }
      onEvent({ kind: 'tool_end', id: u.id, name: u.name, ok, output, ms: Date.now() - t0, agent: ctx.agent });
      results[i] = { type: 'tool_result', tool_use_id: u.id, content: output, ...(ok ? {} : { is_error: true }) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, uses.length) }, worker));
  return results;
}

/** Adds prompt-caching breakpoints (system, tools, latest message) to a copy of the request. */
export function buildRequest(system: string, messages: Message[], tools: MessagesRequest['tools'], model?: string, maxTokens?: number): MessagesRequest {
  const sys: TextBlock[] = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const toolsCopy = (tools ?? []).map((t, i, arr) => (i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t));
  const msgs: Message[] = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content }));
  const last = msgs[msgs.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const lb = last.content[last.content.length - 1] as any;
    if (lb.type === 'text' || lb.type === 'tool_result') {
      lb.cache_control = { type: 'ephemeral' };
    }
  }
  return { model, system: sys, messages: msgs, tools: toolsCopy, max_tokens: maxTokens };
}

// Rough token estimate: ~3.2 characters per token for mixed JSON, code and log text (conservative).
export const CHARS_PER_TOKEN = 3.2;
export const DEFAULT_TOKEN_BUDGET = 140_000;

export function estimateTokens(x: unknown): number {
  const s = typeof x === 'string' ? x : JSON.stringify(x ?? '');
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

const ELIDED = '[older tool output elided to save context; re-run the tool if you need it again]';

/**
 * Keeps the conversation under a token budget. The latest two exchanges are never touched.
 * Tier 1 shrinks old tool results to a 400-char excerpt; tier 2 trims long old assistant text;
 * tier 3 reduces old tool results to a one-line stub.
 */
export function compact(messages: Message[], tokenBudget: number, fixedOverheadTokens = 0) {
  const budget = Math.max(2_000, tokenBudget - fixedOverheadTokens);
  const size = () => estimateTokens(messages);
  if (size() <= budget) {
    return;
  }
  const protectFrom = Math.max(0, messages.length - 4);
  const tiers: Array<(b: ContentBlock) => ContentBlock> = [
    (b) =>
      b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 600 && !b.content.startsWith(ELIDED)
        ? { ...b, content: `${ELIDED}\n${b.content.slice(0, 400)}…` }
        : b,
    (b) => (b.type === 'text' && (b as TextBlock).text.length > 2_000 ? { ...b, text: `${(b as TextBlock).text.slice(0, 1_500)}… [trimmed]` } : b),
    (b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 160 ? { ...b, content: `${ELIDED} (${b.content.length} chars)` } : b),
  ];
  for (const tier of tiers) {
    for (let i = 0; i < protectFrom && size() > budget; i++) {
      const m = messages[i];
      if (Array.isArray(m.content)) {
        m.content = m.content.map(tier);
      }
    }
    if (size() <= budget) {
      return;
    }
  }
}
