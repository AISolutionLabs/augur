# Changelog

## 1.2.0

- OpenAI-compatible API format (Chat Completions) with full translation of messages, tool calls and tool results; `api-key` header for Azure OpenAI; optional `max_completion_tokens`.

## 1.1.0

- Grafana 12.0+ support.
- MCP servers: proxy streamable-HTTP MCP servers (tools/list, tools/call) with no auth, bearer/custom-header secrets, or the user's forwarded OAuth token; per-server tool allow-list and approval policy.
- `/config` exposes configured MCP server names.

## 1.0.0

Initial release.
