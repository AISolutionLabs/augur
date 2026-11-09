# Changelog

## 1.2.0

- MCP client hardening: concurrent initialize/discovery for the same identity collapsed into one request (no session leaks or stampedes); tool discovery follows up to 50 pages, caps at 512 tools per server and reports truncation or cursor loops as a warning in the UI and logs; oversized responses (> 8 MiB, including a single huge SSE line) fail with a clear error; expired sessions and tool caches evicted (rotating OAuth tokens no longer grow memory); failed discovery cached for 30s.
- OpenAI-compatible API format (Chat Completions) with full translation of messages, tool calls and tool results; `api-key` header for Azure OpenAI; optional `max_completion_tokens`.

## 1.1.0

- Grafana 12.0+ support.
- MCP servers: proxy streamable-HTTP MCP servers (tools/list, tools/call) with no auth, bearer/custom-header secrets, or the user's forwarded OAuth token; per-server tool allow-list and approval policy.
- `/config` exposes configured MCP server names.

## 1.0.0

Initial release.
