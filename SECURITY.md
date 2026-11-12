# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security → Advisories) on this repository rather than in a public issue. Include the affected version, configuration (API format, auth method, MCP setup) and steps to reproduce. We aim to acknowledge within 3 working days.

Supported versions: the latest minor release receives fixes.

## Trust boundaries

Augur is two plugins:

| Component | Runs in | Trusted with |
|---|---|---|
| `augur-assistant-app` | The user's browser | Nothing secret. Runs the agent loop and calls Grafana APIs **as the signed-in user**. |
| `augur-claude-datasource` | Grafana server (Go backend) | The model API key / forwarded OAuth token, MCP credentials, and the policy that decides what may be sent where. |

The browser is treated as untrusted: anything the UI enforces is a usability layer, and every security-relevant decision is repeated in the backend.

### Enforced in the backend (cannot be bypassed from the browser)

- **Credentials stay server-side.** API keys and MCP tokens are encrypted `secureJsonData`. Browser-supplied `Authorization`, `x-api-key` and `api-key` headers are dropped; `extraHeaders` cannot override auth.
- **Request shape.** Only a fixed set of Messages API fields is accepted; the model allow-list, `max_tokens` cap and request/response size limits are enforced.
- **No redirects.** The HTTP client never follows redirects, so a misconfigured or compromised gateway cannot bounce credentials to another host.
- **Usage limits** (`limits` in the datasource config): concurrent model calls per user (default 16), calls per minute per user, tokens per user per day and tokens per day for the datasource. They apply to every caller of the resource API, including scripts that bypass the app. Counters are in memory per Grafana replica and reset on restart, so they bound runaway use rather than replacing gateway budgets; with several replicas each enforces its own share.
- **MCP authorization** (per server, admin-owned, in the datasource config):
  - `allowedTools` globs: anything else is neither listed nor callable.
  - A tool must appear in the server's current tool listing to be called (no calling hidden or unlisted names). The listing used to authorize a call is at most a minute old, and is refreshed when a tool is missing.
  - Each listed tool carries a fingerprint of its definition (description, schema, annotations). Calls carry the fingerprint the model and user saw; if the server has since redefined the tool, the call is refused (`409 tool_changed`) instead of running a definition nobody reviewed.
  - Responses must be valid JSON-RPC 2.0 for the request's id, with exactly one of result or error, whether they arrive as JSON, a batch or server-sent events.
  - **Read-only is decided by the admin, not the MCP server.** A tool counts as read-only only if it matches `readOnlyTools`, or if `trustReadOnlyHints` is enabled and the server annotates it `readOnlyHint`. A server's self-declared annotation is ignored by default.
  - Every other tool requires the Grafana role in `writeRole` (default **Editor**). A Viewer calling a state-changing tool gets `403`, regardless of what the UI did.
  - Response bodies are capped (8 MiB), discovery is capped (50 pages / 512 tools), and every call is logged with tool, read-only classification and user.
- **OAuth forwarding.** With *Forward OAuth token*, Augur forwards the user's access or ID token to the gateway and MCP servers. **Augur forwards; it does not authorize.** The receiving service must validate issuer, audience, expiry and signature (JWKS) and map claims to permissions. If no token is present the request fails with 401; there is no fallback to a shared key.

### Enforced in the UI (defence in depth, not a boundary)

- MCP tools that are not read-only also require an **Allow once** click (`requireApproval`, on by default).
- Investigation sub-agents only get read-only tools.
- Dashboard edits, silences and alert rules are **proposals** the user applies; the model has no write tool. Applying them uses the user's own Grafana permissions, and dashboard edits use Grafana's version check so concurrent changes are never overwritten.
- A per-run token ceiling (`maxTokensPerRun`, default 1.5M effective tokens) stops runaway loops; the run then answers from what it has. Every model response counts toward the step limit, including server-side pauses (`pause_turn`, at most three in a row). For a limit that can't be bypassed, use the backend **usage limits** above.
- A per-conversation run lock (the Web Locks API, with a localStorage fallback) ensures only one tab runs a conversation, so model calls and MCP operations are never duplicated across tabs.
- Updating a dashboard saved from an earlier draft uses Grafana's version check: if anyone changed it since Augur saved it, nothing is overwritten.

## Prompt injection

Logs, traces, dashboards, annotations, runbooks and MCP results can contain attacker-controlled text. Augur's stance:

- Tool output is framed as untrusted data, and the system prompt tells the model never to follow instructions found in it. That includes trace attributes, dashboard descriptions, runbooks, MCP tool descriptions and sub-agent briefs: a specialist's brief reaches the lead agent framed as evidence to verify, never as instructions, so relayed injected text gains no authority.
- That is a mitigation, not a guarantee. The real controls are structural: the model cannot write anything without a user click, state-changing MCP tools are gated server-side by role and policy, and sub-agents are read-only. **Assume an injected instruction may influence what the model says and which read-only queries it runs**, and review proposals before applying them.
- Every data query is recorded in an **evidence ledger** (datasource, query, absolute time range, SHA-256 digest of the response, frame/row counts), saved with investigations and reports, so conclusions can be re-checked against the data rather than trusted.

Recommendations: keep `allowedTools` narrow, list read-only tools explicitly in `readOnlyTools`, leave `trustReadOnlyHints` off for servers you don't operate, and keep `writeRole` at Editor or Admin.

## Data and storage

- Conversations, run checkpoints and the evidence ledger of an in-progress session live in the user's browser (`localStorage`), unencrypted. This is a convenience store, not an audit archive: save investigations to Grafana for a durable record. Shared machines should use separate browser profiles; clearing site data removes them.
- Admins can set **Keep conversations for (days)** (`historyRetentionDays`) so older conversations are deleted from users' browsers. Deleting a conversation is final: it is tombstoned so a run still unwinding, a pending save or another tab cannot restore it.
- Saved investigations are ordinary Grafana dashboards, governed by folder permissions.
- Prompts and query results are sent to the configured model endpoint. Use a gateway (e.g. LiteLLM) with your organisation's data-handling controls if that matters to you.

## Supply chain

- Release builds run in GitHub Actions from a tagged commit; artifacts are published with SHA-256 checksums and [build provenance attestations](https://docs.github.com/actions/security-guides/using-artifact-attestations) (`gh attestation verify <zip> --repo AniAIApps/augur`).
- Plugins are signed when the repository has a Grafana access policy token configured; otherwise they must be explicitly allowed with `allow_loading_unsigned_plugins`.
- Go dependencies are pinned in `go.sum`; npm dependencies in `package-lock.json`; GitHub Actions are pinned to commit SHAs (kept current by Dependabot).
