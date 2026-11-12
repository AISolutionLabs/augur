# Troubleshooting

## Installation

??? failure "Plugin doesn't appear, or shows as *unsigned* and disabled"
    Add both IDs to `allow_loading_unsigned_plugins` and restart, or [sign them](../getting-started/signing.md). Check the plugin folder is directly inside the plugins directory (`plugins/augur-assistant-app/plugin.json`, not nested twice). Grafana's log says why a plugin was skipped: search for `augur`.

??? failure "Docker: plugins not loaded with `grafana/otel-lgtm`"
    That image sets `GF_PATHS_PLUGINS=/data/grafana/plugins` in its startup script, overriding your environment. Mount the plugins under `/data/grafana/plugins/`.

??? failure "Augur is under *More apps* instead of the top level"
    Plugins can't choose their menu section. Add to `grafana.ini` (environment variables can't do this):
    ```ini
    [navigation.app_sections]
    augur-assistant-app = root -3450
    ```

??? failure "No sidebar, Augur always opens the full page"
    Your Grafana version doesn't have the extension sidebar. All entry points still work; they open the Augur page.

## Model connection

??? failure "`x509: certificate signed by unknown authority`"
    The gateway uses an internal CA. Add it with `tlsCACertFile` or **Add CA certificate** rather than skipping verification. See [TLS and internal CAs](../configure/tls.md).

??? failure "401 or 403 from the endpoint"
    - **API key:** check the key and the header (`authorization` for LiteLLM/OpenAI, `x-api-key` for Anthropic, `api-key` for Azure).
    - **OAuth:** you must sign in to Grafana through OAuth; `oauthPassThru` must be `true`; the gateway must accept the token's audience (see [Entra ID and LiteLLM](../configure/auth.md#entra-id-and-litellm)). A 401 in the middle of a long run usually means the token expired: sign in again and **Resume**.

??? failure "The model list is empty or missing a model"
    With discovery on, Augur shows what the endpoint's `/v1/models` returns **for your credentials**, filtered by `allowedModels`. Check with **Show models** in the datasource editor. For Azure OpenAI or endpoints without a models API, set `modelDiscovery: off` and list the models in `allowedModels`.

??? failure "`model not allowed`"
    The requested model isn't in the discovered or allowed list. The allow-list is enforced server-side.

??? failure "*Prompt is too long*"
    Augur compacts older tool results and retries once automatically. If it keeps happening, the model has a small context window: choose a larger model or narrow the question.

??? failure "HTTP 429: daily token budget used up, rate limit, or too many calls in progress"
    The datasource's [limits](../configure/datasource.md#limits) refused the call. Rate and concurrency limits clear on their own (Augur retries). A daily budget resets at 00:00 UTC; ask an admin to raise it.

??? failure "*tool … was redefined by the server since it was listed*"
    The MCP server changed that tool's definition after Augur listed it, so the call was refused. The tool list reloads automatically; review the tool and ask again.

??? failure "*… was changed in Grafana since Augur saved it*"
    Someone edited the dashboard after Augur saved it, so **Update saved dashboard** didn't overwrite their changes. Use **Save as new**, or open the dashboard and ask Augur to edit it from its current state.

??? failure "Run stopped: token ceiling reached"
    The run hit `maxTokensPerRun` (default 1.5M) and answered from what it had. Raise it in the app settings if long investigations are expected.

## Using Augur

??? failure "*Running in another tab*"
    Another tab is driving this conversation. Use that tab, or close it: this tab takes over within about 12 seconds.

??? failure "*3 conversations are already running*"
    Up to three conversations run at once. Wait for one to finish or stop one from the conversations list.

??? failure "Dashboard preview panels show *No data*"
    The preview queries the last hour with variables set to all values. Check the **query check** on the card. Ask Augur to fix empty panels, or check whether the data is simply older than an hour.

??? failure "PDF export does nothing"
    The PDF button opens the browser's print dialog from a hidden frame. Some kiosk or locked-down browsers disable printing; use **Markdown** export instead.

??? failure "React error #185 (*Maximum update depth exceeded*) while typing"
    Fixed in 1.5.2. Upgrade both plugins.

## Getting help

Open an [issue](https://github.com/AniAIApps/augur/issues) with your Grafana version, Augur version, API format and auth method, and the error from the browser console or Grafana log. Report security issues privately: see [Security model](security.md).
