# MCP servers

Give Augur your own tools through [Model Context Protocol](https://modelcontextprotocol.io/) servers: GitHub, Azure DevOps, Kubernetes, your wiki, a CMDB, a deploy system. Their tools show up to the model as `mcp__<server>__<tool>`.

MCP calls go through the datasource backend, so tokens stay server-side and every policy below is enforced on the server, not in the browser. Augur supports the **streamable HTTP** transport (JSON and SSE responses).

## Configure a server

In the datasource editor under **MCP servers**, or in provisioning:

```yaml
jsonData:
  mcpServers:
    - name: github
      url: https://mcp.example.internal/github/mcp
      auth: bearer
      allowedTools: ['get_*', 'search_*', 'list_*', 'create_issue']
      readOnlyTools: ['get_*', 'search_*', 'list_*']
      writeRole: Editor
    - name: ado
      url: https://mcp.example.internal/ado/mcp
      auth: oauth                 # forwards the signed-in user's token
      trustReadOnlyHints: true    # only for servers you operate
secureJsonData:
  mcpToken_github: ${GITHUB_MCP_TOKEN}
```

| Field | Meaning |
|---|---|
| `name` | Short name; becomes part of tool names (`mcp__github__search_issues`) |
| `url` | Streamable HTTP endpoint |
| `auth` | `none`, `bearer` (token from `secureJsonData.mcpToken_<name>`), `header` (custom `headerName` with that token), or `oauth` (the user's token; needs OAuth forwarding on the datasource) |
| `allowedTools` | Globs of tools to expose. Anything else is neither listed nor callable. Empty means all. |
| `readOnlyTools` | Globs of tools **you** declare read-only |
| `trustReadOnlyHints` | Also treat tools the server annotates `readOnlyHint` as read-only. Off by default. |
| `writeRole` | Minimum Grafana role for other tools: `Viewer`, `Editor` (default) or `Admin` |
| `requireApproval` | Ask the user to **Allow once** before non-read-only tools run. Default `true`. |

## How calls are authorized

```mermaid
flowchart TD
  C[Model calls mcp__server__tool] --> A{In allowedTools<br/>and in the server's<br/>current tool list?}
  A -- no --> R1[Rejected]
  A -- yes --> B{Read-only?<br/>readOnlyTools, or hint<br/>if trustReadOnlyHints}
  B -- yes --> RUN[Runs]
  B -- no --> D{User's role ≥ writeRole?<br/>(enforced in backend)}
  D -- no --> R2[403]
  D -- yes --> E{User clicks<br/>Allow once?}
  E -- no --> R3[Declined]
  E -- yes --> RUN
```

- Read-only is the **admin's** decision. A server's own `readOnlyHint` is self-declared and ignored unless you set `trustReadOnlyHints`.
- Investigation sub-agents only get read-only tools.
- **Fresh catalog for every decision.** The tool list shown to the model is cached for 5 minutes, but a call is authorized against a list at most a minute old, so a tool the server withdrew stops being callable quickly.
- **Definitions are fingerprinted.** Each listed tool carries a fingerprint of its description, schema and annotations, and calls send the fingerprint the model and user saw. If the server redefined the tool since (say its description now says it also deletes forks), the call is refused with `409 tool_changed` and the list reloads.
- **Strict protocol checks.** Responses must be valid JSON-RPC 2.0 with the request's id and exactly one of result or error, over JSON, batch or SSE alike.
- Responses are capped at 8 MiB; discovery at 50 pages / 512 tools. Every call is logged with the tool, its read-only classification and the user. Augur identifies itself to MCP servers as `augur-grafana` with its plugin version.

!!! tip "Recommendations"
    Keep `allowedTools` narrow, list read-only tools explicitly, leave `trustReadOnlyHints` off for servers you don't run, and keep `writeRole` at Editor or Admin.
