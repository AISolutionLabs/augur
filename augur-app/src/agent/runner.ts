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
  /** Approximate character budget for the request before old tool results are elided. */
  contextCharBudget?: number;
  toolConcurrency?: number;
  /**
   * Called when the model wants to stop. Returning text sends it as a user nudge and continues the
   * loop once (used as the investigation "conclusion gate").
   */
  beforeFinish?: () => string | undefined;
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
    compact(messages, opts.contextCharBudget ?? 450_000);
    const req = buildRequest(opts.system, messages, toolSchemas, opts.model, opts.maxTokens);
    if (finalCall) {
      (req as any).tool_choice = { type: 'none' };
    }
    onEvent({ kind: 'status', text: steps === 0 ? 'Thinking…' : `Analysing results (step ${steps + 1})…` });

    let resp;
    try {
      resp = await call(req, ctx.signal);
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
        continue;
      }
    }
    if (!toolUses.length || finalCall) {
      onEvent({ kind: 'done', stopReason: String(resp.stop_reason ?? 'end_turn'), steps });
      return messages;
    }

    const results = await runTools(toolUses, byName, ctx, onEvent, opts.toolConcurrency ?? 4);
    const userContent: ContentBlock[] = [...results];
    if (steps >= opts.maxSteps) {
      finalCall = true;
      userContent.push({
        type: 'text',
        text: 'Tool budget for this turn is used up. Do not call more tools. Give your best answer now from the evidence gathered, and say what you would check next.',
      });
    }
    messages.push({ role: 'user', content: userContent });
  }
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
        output = clip(await tool.run((u.input ?? {}) as Record<string, any>, ctx));
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

const ELIDED = '[older tool output elided to save context; re-run the tool if you need it again]';

/** Shrinks the oldest tool results until the conversation fits the budget. Keeps the latest 2 exchanges intact. */
export function compact(messages: Message[], budget: number) {
  const size = () => JSON.stringify(messages).length;
  if (size() <= budget) {
    return;
  }
  const protectFrom = Math.max(0, messages.length - 4);
  for (let i = 0; i < protectFrom && size() > budget; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) {
      continue;
    }
    m.content = m.content.map((b) => {
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 600 && !b.content.startsWith(ELIDED)) {
        return { ...b, content: `${ELIDED}\n${b.content.slice(0, 400)}…` };
      }
      return b;
    });
  }
}
