# Models and providers

Augur is designed and tested with **Claude**. Its prompts, tool schemas and agent loop assume a model that's strong at multi-step tool use. It also works with other providers through two wire formats.

| Format | Endpoint | Use for |
|---|---|---|
| **Claude Messages** (default) | `/v1/messages` | Anthropic API, LiteLLM, Bedrock or Vertex behind a gateway |
| **OpenAI-compatible** | `/v1/chat/completions` | OpenAI, Azure OpenAI, vLLM, Ollama, LiteLLM's OpenAI route |

With OpenAI-compatible, the backend translates messages, tool calls, tool results, stop reasons and token usage (including cached tokens) both ways, so the agent works the same.

!!! tip "Model choice matters"
    Chat and dashboard building work with most capable models. Investigations make many tool calls in a row and depend heavily on tool-use reliability; smaller or open-weight models will run but give weaker results.

## Recipes

=== "LiteLLM"

    The recommended setup in a company: one gateway with your keys, budgets, logging and guardrails.

    ```yaml
    url: https://litellm.example.internal
    jsonData:
      authMethod: apiKey
      apiKeyHeader: authorization
      defaultModel: claude-sonnet-5-5      # names as your proxy exposes them
      allowedModels: ['claude-*']
    secureJsonData:
      apiKey: sk-litellm-virtual-key
    ```

    LiteLLM's `/v1/messages` can route to Bedrock, Vertex, Anthropic, or OpenAI models behind the proxy, and model discovery shows only what the key can use. To give each user their own identity at the gateway, see [Authentication](auth.md).

=== "Anthropic API"

    ```yaml
    url: https://api.anthropic.com
    jsonData:
      authMethod: apiKey
      apiKeyHeader: x-api-key
      defaultModel: claude-sonnet-5-5
    secureJsonData:
      apiKey: sk-ant-...
    ```

=== "AWS Bedrock"

    Bedrock doesn't accept plain API-key calls on the Messages API. Put a gateway in front of it (LiteLLM is the common choice) and use the LiteLLM recipe. LiteLLM signs requests with the pod's IAM role.

=== "OpenAI"

    ```yaml
    url: https://api.openai.com
    jsonData:
      apiFormat: openai
      messagesPath: /v1/chat/completions
      maxTokensField: max_completion_tokens   # required by reasoning models
      authMethod: apiKey
      apiKeyHeader: authorization
      defaultModel: gpt-5
      allowedModels: ['gpt-5*']
    secureJsonData:
      apiKey: sk-...
    ```

=== "Azure OpenAI"

    ```yaml
    url: https://my-resource.openai.azure.com
    jsonData:
      apiFormat: openai
      messagesPath: /openai/deployments/my-deployment/chat/completions?api-version=2024-10-21
      maxTokensField: max_completion_tokens
      authMethod: apiKey
      apiKeyHeader: api-key
      modelDiscovery: off                   # Azure routes by deployment, not model name
      defaultModel: my-deployment
    secureJsonData:
      apiKey: ...
    ```

=== "vLLM / Ollama"

    ```yaml
    url: http://ollama.ai.svc:11434          # or your vLLM server
    jsonData:
      apiFormat: openai
      messagesPath: /v1/chat/completions
      authMethod: none
      defaultModel: qwen3:32b
    ```

    The model must support tool (function) calling.

## What's translated for OpenAI-compatible endpoints

| Claude Messages | Chat Completions |
|---|---|
| `system` | `system` message |
| `text` blocks | `content` |
| `tool_use` blocks | `tool_calls` (function) |
| `tool_result` blocks | `tool` role messages |
| `tools[].input_schema` | `tools[].function.parameters` |
| `stop_reason` | from `finish_reason` |
| `usage` incl. `cache_read_input_tokens` | from `usage` and `prompt_tokens_details.cached_tokens` |

Thinking blocks and prompt-caching hints are Claude-specific and dropped.

## Budgets and limits

| Limit | Where | Default |
|---|---|---|
| `max_tokens` per model call | Datasource **Max tokens** | 8192 |
| Tokens per run (sub-agents included) | App setting `maxTokensPerRun` | 1.5M effective tokens (cache reads weighted 10%) |
| Steps per run | App setting `stepBudget` | chat 15, investigate 45 |
| Conversation context | Built in | 140k tokens, older tool results compacted first |

When the per-run ceiling is reached, the run stops querying and answers from what it has.
