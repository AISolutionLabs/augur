// Investigation-only tools: hypothesis board and parallel specialist sub-agents.

import { ModelCaller, ToolContext, ToolDefinition, AgentEvent, Message, ContentBlock } from '../types';
import { runAgent } from '../runner';
import { clip } from '../frames';

export function hypothesisTool(): ToolDefinition {
  const ids = new Map<string, string>();
  return {
    schema: {
      name: 'update_hypothesis',
      description:
        'Create or update a hypothesis on the investigation board. Track every serious candidate cause. Set status (open/supported/refuted/confirmed), a confidence 0-1, the evidence, and challenged=true once you have actively tried to falsify it. Reuse the same key to update.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short stable id, e.g. "db-pool"' },
          statement: { type: 'string' },
          status: { type: 'string', enum: ['open', 'supported', 'refuted', 'confirmed'] },
          confidence: { type: 'number' },
          evidence: { type: 'string' },
          challenged: { type: 'boolean' },
        },
        required: ['key', 'statement', 'status', 'confidence'],
      },
    },
    describe: (i) => `Hypothesis ${i.status}: ${i.statement}`,
    run: async (input, ctx) => {
      const key = String(input.key);
      const id = ids.get(key) ?? key;
      ids.set(key, id);
      ctx.updateHypothesis?.({
        id,
        statement: String(input.statement),
        status: input.status,
        confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)),
        evidence: input.evidence,
        challenged: !!input.challenged,
        updatedAt: ctx.now(),
      });
      return 'Updated.';
    },
  };
}

export interface DelegateDeps {
  call: ModelCaller;
  model?: string;
  maxTokens?: number;
  /** Builds the toolset for a sub-agent (without delegate/proposal tools). */
  subTools: () => ToolDefinition[];
  /** Base system prompt (environment, rules, inventory) shared with sub-agents. */
  baseSystem: string;
  onEvent: (e: AgentEvent) => void;
  maxSteps?: number;
}

const SUB_PROMPT = `
You are a specialist sub-agent working for a lead investigator. Work ONLY on your assigned objective, efficiently (parallel tool calls when independent). Do not write a full report.
Finish with a compact brief:
FINDINGS: bullet list of facts with timestamps (UTC) and the exact query that shows each.
ANOMALIES: what changed and when, magnitude vs baseline.
LEADS: trace IDs, services, pods, error signatures worth following.
NOT FOUND: what you checked that showed nothing unusual.`;

export function delegateTool(deps: DelegateDeps): ToolDefinition {
  return {
    schema: {
      name: 'delegate',
      description:
        'Run up to 4 specialist sub-agents IN PARALLEL, each with its own context and tool budget, and get back their condensed briefs. Use early in an investigation to cover signals in breadth (e.g. one for metrics/golden signals, one for logs, one for traces, one for alerts+deploys), or to investigate several suspect services at once. Give each a precise objective including service names, time window and what to compare against.',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              properties: { name: { type: 'string', description: 'Short label, e.g. "logs"' }, objective: { type: 'string' } },
              required: ['name', 'objective'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    describe: (i) => `Delegate to ${(i.tasks ?? []).map((t: any) => t.name).join(', ')}`,
    run: async (input, ctx: ToolContext) => {
      const tasks = (input.tasks ?? []).slice(0, 4) as Array<{ name: string; objective: string }>;
      if (!tasks.length) {
        throw new Error('no tasks');
      }
      const results = await Promise.all(
        tasks.map(async (t) => {
          const messages: Message[] = [{ role: 'user', content: `Objective: ${t.objective}` }];
          try {
            const out = await runAgent({
              call: deps.call,
              model: deps.model,
              maxTokens: deps.maxTokens,
              tools: deps.subTools(),
              system: deps.baseSystem + SUB_PROMPT,
              messages,
              maxSteps: deps.maxSteps ?? 12,
              ctx: { ...ctx, agent: t.name },
              onEvent: (e) => {
                if (e.kind === 'tool_start' || e.kind === 'tool_end' || e.kind === 'usage' || e.kind === 'finding') {
                  deps.onEvent(e);
                }
              },
              contextTokenBudget: 80_000,
            });
            const last = [...out].reverse().find((m) => m.role === 'assistant');
            const text = Array.isArray(last?.content)
              ? (last!.content as ContentBlock[])
                  .filter((b) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join('\n')
              : String(last?.content ?? '');
            return `### ${t.name}\n${clip(text || '(no brief returned)', 6000)}`;
          } catch (e: any) {
            return `### ${t.name}\nSub-agent failed: ${e?.message ?? e}`;
          }
        })
      );
      return results.join('\n\n');
    },
  };
}
