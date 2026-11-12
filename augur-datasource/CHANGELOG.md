# Changelog

## 1.7.0

- **Usage limits enforced by the backend** (`limits`): concurrent model calls per user (default 16), calls per minute per user, tokens per user per day and tokens per day for the datasource, using the same effective-token weighting as the app's per-run budget. They apply to any caller of the resource API, so they can't be bypassed by skipping the app. Refusals are `429` with a typed error (`rate_limit_exceeded`, `concurrency_limit_exceeded` with `Retry-After`, or `budget_exceeded`). Counters are per datasource and per Grafana replica, kept across settings changes and reset on restart. New *Limits* section in the config editor.
- **MCP responses are validated the same way for every transport**: JSON-RPC 2.0, matching request id, exactly one of result or error. Single JSON responses previously skipped the id check.
- **MCP catalog freshness**: calls are authorized against a tool list at most a minute old (the listing cache stays 5 minutes) and the cache is invalidated when a tool is missing; each listed tool carries a definition fingerprint (`augurFingerprint`), and a call whose fingerprint no longer matches is refused with `409 tool_changed`.
- The MCP client reports the plugin's real version (from Grafana) instead of a hard-coded `1.2.0`.
- Provider-neutral messages ("model endpoint" instead of "Claude endpoint").

## 1.5.2

- Repository moved to [AniAIApps/augur](https://github.com/AniAIApps/augur): plugin links and the Go module path updated. No functional changes.

## 1.5.0

- Models are discovered from the endpoint's `/v1/models` (Anthropic paging and OpenAI/LiteLLM shapes) using the caller's credentials, cached per credential for 5 minutes; non-chat models (embeddings, audio, image) are dropped; `allowedModels` now accepts patterns (`claude-*`) and filters the list; requests for undiscovered models are rejected. Falls back to the configured list if the endpoint can't list models. `modelDiscovery: off` restores a fixed list. New `/models` resource and a *Show models* preview in the config editor.
- Internal CAs: *Add CA certificate* (PEM) and a CA bundle file path (`tlsCACertFile`, e.g. a mounted ConfigMap) are trusted in addition to the system roots, for the endpoint and MCP servers; invalid or unreadable CAs are reported by *Save & test*. TLS settings (CA, server name, skip verify) are now in the config editor.

## 1.4.0

- Covered by the new end-to-end tests: plugin loading on Grafana 13, health check and the Messages proxy path against a stub model.

## 1.3.0

- **Security:** MCP authorization is now enforced server-side. Only tools in the server's current listing (and the allow-list) can be called; tools are read-only only if they match the admin's `readOnlyTools` globs, or the server's `readOnlyHint` when `trustReadOnlyHints` is enabled; every other tool requires the `writeRole` (default Editor) and returns 403 otherwise. Calls are logged with their classification and user.
- **Security:** the HTTP client no longer follows redirects, so credentials cannot be forwarded to a redirect target.
- Config editor: read-only tool globs, role required for other tools, and trust-annotations switch per MCP server; `writeRole` is validated.

## 1.2.0

- MCP client hardening: concurrent initialize/discovery for the same identity collapsed into one request (no session leaks or stampedes); tool discovery follows up to 50 pages, caps at 512 tools per server and reports truncation or cursor loops as a warning in the UI and logs; oversized responses (> 8 MiB, including a single huge SSE line) fail with a clear error; expired sessions and tool caches evicted (rotating OAuth tokens no longer grow memory); failed discovery cached for 30s.
- OpenAI-compatible API format (Chat Completions) with full translation of messages, tool calls and tool results; `api-key` header for Azure OpenAI; optional `max_completion_tokens`.

## 1.1.0

- Grafana 12.0+ support.
- MCP servers: proxy streamable-HTTP MCP servers (tools/list, tools/call) with no auth, bearer/custom-header secrets, or the user's forwarded OAuth token; per-server tool allow-list and approval policy.
- `/config` exposes configured MCP server names.

## 1.0.0

Initial release.
