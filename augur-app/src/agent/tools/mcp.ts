// MCP server tools, proxied through the Claude (Augur) datasource backend so they can reach
// internal endpoints and use server-side credentials or the user's forwarded OAuth token.

import { GrafanaHttp, ToolDefinition } from '../types';
import { clip } from '../frames';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
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

export function mcpTools(catalog: McpCatalog, dsUid: string): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const server of catalog.servers) {
    for (const t of server.tools ?? []) {
      const name = `mcp__${safeName(server.name)}__${safeName(t.name)}`.slice(0, 64);
      const readOnly = t.annotations?.readOnlyHint === true;
      out.push({
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
