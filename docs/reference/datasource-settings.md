# Datasource settings

All fields of the `augur-claude-datasource` datasource, for provisioning.

## jsonData

| Field | Type | Default | Description |
|---|---|---|---|
| `apiFormat` | `anthropic` \| `openai` | `anthropic` | Wire format of the endpoint |
| `messagesPath` | string | `/v1/messages` (`/v1/chat/completions` for `openai`) | Path of the messages endpoint; for Azure include deployment and `?api-version=` |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `max_tokens` | OpenAI format only; newer OpenAI models need `max_completion_tokens` |
| `authMethod` | `apiKey` \| `oauth` \| `none` | `apiKey` | How to authenticate upstream |
| `apiKeyHeader` | `authorization` \| `x-api-key` \| `api-key` | `authorization` | Header carrying the API key |
| `oauthPassThru` | bool | `false` | Must be `true` with `authMethod: oauth` |
| `oauthTokenType` | `access` \| `id` | `access` | Which OAuth token to forward |
| `anthropicVersion` | string | `2023-06-01` | `anthropic-version` header (Messages format) |
| `defaultModel` | string | `claude-sonnet-5-5` | Model for new conversations |
| `modelDiscovery` | `endpoint` \| `off` | `endpoint` | Offer the models the endpoint lists for the caller's credentials |
| `modelsPath` | string | `/v1/models` | Models API path for discovery |
| `allowedModels` | string[] | none | Names or globs. Filter for discovery, or the list when discovery is off. Enforced server-side. |
| `maxTokens` | int | `8192` | Cap on `max_tokens` per call |
| `timeoutSeconds` | int | `300` | Upstream request timeout |
| `tlsCACertFile` | path | none | PEM bundle trusted in addition to system roots |
| `tlsAuthWithCACert` | bool | `false` | Use `secureJsonData.tlsCACert` |
| `tlsSkipVerify` | bool | `false` | Skip TLS verification (not recommended) |
| `extraHeaders` | map | none | Static, non-secret headers sent upstream; can't override auth |
| `mcpServers` | list | none | See [MCP servers](../configure/mcp.md) |

## secureJsonData

| Field | Description |
|---|---|
| `apiKey` | The API key (`authMethod: apiKey`) |
| `tlsCACert` | PEM CA certificate(s) |
| `mcpToken_<name>` | Token for MCP server `<name>` (`auth: bearer` or `header`) |

## mcpServers[]

| Field | Default | Description |
|---|---|---|
| `name` | required | Short name, used in tool names |
| `url` | required | Streamable HTTP endpoint |
| `auth` | `none` | `none`, `bearer`, `header`, `oauth` |
| `headerName` | none | Header for `auth: header` |
| `allowedTools` | all | Globs of tools to expose |
| `readOnlyTools` | none | Globs of tools the admin declares read-only |
| `trustReadOnlyHints` | `false` | Also trust the server's `readOnlyHint` |
| `writeRole` | `Editor` | Minimum role for non-read-only tools |
| `requireApproval` | `true` | **Allow once** click for non-read-only tools |
