# Headless runner

The same agent, tools and prompts can run outside the browser, against Grafana's HTTP API with a service-account token. Use it for scripted checks, CI gates, scheduled reports or benchmarks.

## Build

```bash
cd augur-app && npm ci && npm run build:headless
# → dist-headless/augur-headless.mjs (a single file; needs Node 20 or later)
```

## Run

=== "Through an Augur datasource"

    Uses the datasource's credentials, model allow-list and limits:

    ```bash
    GRAFANA_URL=https://grafana.example.com \
    GRAFANA_TOKEN=glsa_... \
    AUGUR_DATASOURCE_UID=claude \
    node dist-headless/augur-headless.mjs "Which service has the highest error rate in the last hour?"
    ```

=== "Model endpoint directly"

    ```bash
    GRAFANA_URL=https://grafana.example.com \
    GRAFANA_TOKEN=glsa_... \
    MODEL_BASE_URL=https://litellm.example.internal \
    MODEL_API_KEY=sk-... \
    MODEL=claude-sonnet-5-5 \
    node dist-headless/augur-headless.mjs "Which service has the highest error rate in the last hour?"
    ```

## Environment

| Variable | Meaning |
|---|---|
| `GRAFANA_URL` | Grafana base URL |
| `GRAFANA_TOKEN` or `GRAFANA_USER` / `GRAFANA_PASSWORD` | Identity whose permissions apply |
| `AUGUR_DATASOURCE_UID` | Call the model through this Augur datasource, **or** |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL` | Call a Claude Messages endpoint directly (`/v1/messages` is appended) |
| `MODEL_AUTH_HEADER` | `x-api-key` for the Anthropic API (default `Authorization: Bearer`) |
| `AUGUR_MODE` | `chat` (default) or `investigate` |
| `AUGUR_APPLY` | `auto` applies proposals (dashboards, silences, rules) automatically. **Off by default.** |
| `AUGUR_TRAJECTORY` | Write the run as an [ATIF](https://github.com/laude-institute/harbor) trajectory: tool calls, results, evidence, token usage |
| `AUGUR_ANSWER` | Write the final answer to this file |
| `AUGUR_NOW` | Fixed "current time" (ISO) for reproducible runs |

The final answer is printed to stdout. Exit codes: `0` finished, `1` the run ended with an error, `2` configuration or connection failure (message on stderr).

## Applying proposals unattended

With `AUGUR_APPLY=auto`, each proposal is applied as it's made and the outcome is fed back to the model, so it can fix failures the way a user would. Revisions of a dashboard draft update the dashboard saved from the earlier revision rather than creating copies.

!!! warning
    Only use `AUGUR_APPLY=auto` with a service account scoped to what the job should be able to change.

## Example: nightly health summary in CI

```yaml
- name: Augur health summary
  run: |
    node augur-headless.mjs "Summarise errors and latency regressions in the last 24h for the payments namespace"
  env:
    GRAFANA_URL: ${{ vars.GRAFANA_URL }}
    GRAFANA_TOKEN: ${{ secrets.GRAFANA_VIEWER_TOKEN }}
    AUGUR_DATASOURCE_UID: claude
    AUGUR_ANSWER: summary.md
```
