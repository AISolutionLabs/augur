// MCP server tools, proxied through the Claude (Augur) datasource backend so they can reach
// internal endpoints and use server-side credentials or the user's forwarded OAuth token.

import { GrafanaHttp, ToolDefinition } from '../types';
import { clip } from '../frames';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
  /** Augur's effective read-only decision, made by the backend from the admin's policy. */
  augurReadOnly?: boolean;
}

export interface McpCatalog {
  servers: Array<{ name: string; tools: McpToolInfo[]; error?: string; warning?: string; requireApproval?: boolean }>;
}

export async function loadMcpCatalog(http: GrafanaHttp, dsUid: string): Promise<McpCatalog> {
  try {
    return await http.get<McpCatalog>(`/api/datasources/uid/${encodeURIComponent(dsUid)}/resources/mcp/tools`);
  } catch {
    return { servers: [] };
  }
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Short stable hash (FNV-1a) used to keep sanitised/truncated tool names unique. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/**
 * API tool name for an MCP tool: mcp__<server>__<tool>, at most 64 chars of [a-zA-Z0-9_-].
 * Sanitising or truncating can make two different tools look alike ("my.tool" vs "my_tool", long
 * names sharing a prefix); those get a hash suffix of the original server/tool pair so none is
 * silently dropped as a duplicate.
 */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  const plain = `mcp__${safeName(server)}__${safeName(tool)}`;
  const exact = plain === `mcp__${server}__${tool}`;
  if (plain.length <= 64 && exact && !taken.has(plain)) {
    return plain;
  }
  const suffix = `_${shortHash(`${server}\u0000${tool}`)}`;
  return `${plain.slice(0, 64 - suffix.length)}${suffix}`;
}

export function mcpTools(catalog: McpCatalog, dsUid: string): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  const taken = new Set<string>();
  for (const server of catalog.servers) {
    for (const t of server.tools ?? []) {
      const name = mcpToolName(server.name, t.name, taken);
      taken.add(name);
      // Never trust the server's own readOnlyHint here: the backend applies the admin's policy.
      const readOnly = t.augurReadOnly === true;
      out.push({
        readOnly,
        schema: {
          name,
          description: `[MCP server "${server.name}"${readOnly ? ', read-only' : ''}] ${t.description ?? t.name}`.slice(0, 1024),
          input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
        describe: () => `${server.name}: ${t.annotations?.title ?? t.name}`,
        run: async (input, ctx) => {
          const needsApproval = server.requireApproval !== false && !readOnly;
          if (needsApproval) {
            const ok = await (ctx.confirm?.({
              title: `Allow ${server.name} → ${t.name}?`,
              detail: `This MCP tool is not marked read-only and may change things in ${server.name}.\n\nArguments:\n${JSON.stringify(input, null, 2)}`,
            }) ?? Promise.resolve(false));
            if (!ok) {
              return 'The user declined this tool call. Do not retry it; continue without it or ask the user.';
            }
          }
          const r = await ctx.http.post<{ content?: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean; structuredContent?: unknown }>(
            `/api/datasources/uid/${encodeURIComponent(dsUid)}/resources/mcp/call`,
            { server: server.name, tool: t.name, arguments: input },
            ctx.signal
          );
          const text = (r?.content ?? [])
            .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? JSON.stringify(c.resource ?? c) : `[${c.type} content omitted]`))
            .join('\n');
          const body = text || (r?.structuredContent ? JSON.stringify(r.structuredContent) : '(empty result)');
          if (r?.isError) {
            throw new Error(clip(body, 4000));
          }
          return clip(body);
        },
      });
    }
  }
  return out;
}
