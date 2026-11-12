# Model datasource

The **Claude (Augur)** datasource connects Augur to your model endpoint. It runs in the Grafana server, holds the credentials, and enforces the model allow-list and limits. The browser never sees a key.

Add it under **Connections → Data sources → Add data source → Claude (Augur)**, or [provision it](#provisioning).

## Settings

| Setting | What it does |
|---|---|
| **URL** | Base URL of the endpoint, e.g. `https://litellm.example.internal` or `https://api.anthropic.com` |
| **API format** | **Claude Messages** (default, recommended) or **OpenAI-compatible** (Chat Completions). See [Models and providers](models.md). |
| **Messages path** | Default `/v1/messages`, or `/v1/chat/completions` for OpenAI-compatible. Azure: include the deployment path and `?api-version=`. |
| **Authentication** | **API key**, **Forward OAuth token**, or **None** (network or mTLS auth). See [Authentication](auth.md). |
| **API key header** | `Authorization: Bearer` (LiteLLM, OpenAI), `x-api-key` (Anthropic) or `api-key` (Azure OpenAI) |
| **Default model** | The model selected for new conversations. Default `claude-sonnet-5-5`. |
| **Model discovery** | **On** (default): offer the models the endpoint lists at `/v1/models` for the caller's credentials. **Off**: offer only the default and allowed models. |
| **Allowed models** | Names or globs (`claude-*`). With discovery on they filter the discovered list; with it off they are the list. Requests for any other model are rejected server-side. |
| **Max tokens** | Cap on `max_tokens` per model call. Default 8192. |
| **Timeout** | Per request, default 300 seconds. |
| **TLS** | Extra CA certificates for internal endpoints. See [TLS and internal CAs](tls.md). |
| **Extra headers** | Static, non-secret headers sent upstream (for example LiteLLM tags). They can't override auth headers. |
| **MCP servers** | Remote tool servers. See [MCP servers](mcp.md). |

**Show models** in the editor previews exactly which models users will be offered.

## Save & test

**Save & test** checks that the endpoint is reachable with the configured credentials and TLS settings. It reports an unreadable or invalid CA, a connection failure, or credentials the endpoint rejects (401/403). Use **Show models** to check the model list.

With **Forward OAuth token**, the test runs as you. It fails if you didn't sign in through OAuth.

## Provisioning

```yaml
apiVersion: 1
datasources:
  - name: Claude
    uid: claude
    type: augur-claude-datasource
    url: https://litellm.example.internal
    jsonData:
      apiFormat: anthropic          # or openai
      authMethod: apiKey            # apiKey | oauth | none
      apiKeyHeader: authorization   # authorization | x-api-key | api-key
      defaultModel: claude-sonnet-5-5
      allowedModels: ['claude-*']
      modelDiscovery: endpoint      # or off
      maxTokens: 8192
      timeoutSeconds: 300
      tlsCACertFile: /etc/ssl/internal/ca.pem
      extraHeaders:
        x-litellm-tags: grafana-augur
    secureJsonData:
      apiKey: ${LITELLM_KEY}
```

All fields are in the [datasource settings reference](../reference/datasource-settings.md).

## More than one datasource

You can add several Augur datasources, for example one for a fast cheap model and one for the strongest model, or one per team with different keys and budgets. Users pick the datasource and model in the chat header, and Grafana datasource permissions control who can use which.
