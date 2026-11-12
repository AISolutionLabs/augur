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
| **Limits** | Per-user concurrency, rate and daily token budgets, enforced server-side. See [below](#limits). |

**Show models** in the editor previews exactly which models users will be offered.

## Save & test

**Save & test** checks that the endpoint is reachable with the configured credentials and TLS settings. It reports an unreadable or invalid CA, a connection failure, or credentials the endpoint rejects (401/403). Use **Show models** to check the model list.

With **Forward OAuth token**, the test runs as you. It fails if you didn't sign in through OAuth.

## Limits

Limits are enforced by the datasource backend for every caller, including scripts that call Grafana's resource API directly, so they hold even if someone bypasses the app.

| Setting | Default | Meaning |
|---|---|---|
| **Concurrent calls per user** | 16 | Model calls one user may have in flight. Three parallel conversations with sub-agents fit comfortably. `-1` disables. |
| **Calls per minute per user** | none | Rolling 60-second window |
| **Tokens per user per day** | none | Effective tokens (input + output + cache writes, cache reads at 10%), reset at 00:00 UTC |
| **Tokens per day (all users)** | none | The same, for everyone using this datasource |

Refused calls get `429`. Rate and concurrency limits clear on their own, and Augur retries them with backoff. A spent daily budget is shown to the user straight away, without retries.

!!! note "Scope"
    Counters live in the memory of each Grafana replica and reset on restart. They bound runaway use (a stuck client, a compromised account) well. For organisation-wide spend control across replicas, also set budgets at your gateway (LiteLLM keys, teams and budgets).

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
      limits:
        maxConcurrentPerUser: 16
        requestsPerMinutePerUser: 60
        tokensPerUserPerDay: 5000000
    secureJsonData:
      apiKey: ${LITELLM_KEY}
```

All fields are in the [datasource settings reference](../reference/datasource-settings.md).

## More than one datasource

You can add several Augur datasources, for example one for a fast cheap model and one for the strongest model, or one per team with different keys and budgets. Users pick the datasource and model in the chat header, and Grafana datasource permissions control who can use which.
