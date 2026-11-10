# Claude (Augur) datasource

The backend for the [Augur](https://github.com/AniAIApps/augur) app. It proxies Claude Messages API calls from Grafana to your gateway, either LiteLLM, the Anthropic API, or any compatible endpoint, and adds credentials on the server so they never reach the browser.

**Authentication**
- **API key:** stored encrypted and sent as `Authorization: Bearer` (LiteLLM virtual keys) or `x-api-key` (Anthropic).
- **Forward OAuth token:** sends the signed-in user's own OAuth access token or OIDC ID token (e.g. Entra ID), so the gateway can apply per-user routing, budgets and audit. Users must sign in to Grafana via OAuth.

**Guardrails:** a model allow-list, an output-token cap, a fixed set of request fields, request and response size limits, and usage attributed via `metadata.user_id`.

*Save & test* checks connectivity and credentials against `/v1/models`. This datasource can't be queried from panels; use the Augur app.

**MCP servers:** proxies remote MCP servers (streamable HTTP) for the Augur app, with no auth, a stored bearer/header secret, or the user's forwarded OAuth token, plus per-server tool allow-lists.

Requires Grafana 12.0+.
