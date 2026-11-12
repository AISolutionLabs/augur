# Quick start (Docker)

Run Augur locally with Grafana, Prometheus, Loki and Tempo, preloaded with sample telemetry from `grafana/otel-lgtm`. It takes about five minutes.

## Prerequisites

- Docker with Compose
- A model key: an Anthropic API key, or a LiteLLM URL and virtual key
- To build from source: Node 22, Go and [mage](https://magefile.org/). Or skip the build and use the release zips.

## 1. Get the plugins

=== "Build from source"

    ```bash
    git clone https://github.com/AniAIApps/augur && cd augur
    make install build
    ```

=== "Use a release"

    ```bash
    git clone https://github.com/AniAIApps/augur && cd augur
    VERSION=1.6.0   # see https://github.com/AniAIApps/augur/releases
    curl -LO https://github.com/AniAIApps/augur/releases/download/v$VERSION/augur-assistant-app-$VERSION.zip
    curl -LO https://github.com/AniAIApps/augur/releases/download/v$VERSION/augur-claude-datasource-$VERSION.zip
    unzip -q augur-assistant-app-$VERSION.zip -d /tmp/app && mv /tmp/app/*/ augur-app/dist
    unzip -q augur-claude-datasource-$VERSION.zip -d /tmp/ds && mv /tmp/ds/*/ augur-datasource/dist
    ```

## 2. Point it at a model

=== "Anthropic API"

    ```bash
    export ANTHROPIC_API_KEY=sk-ant-...
    ```

=== "LiteLLM"

    Edit `deploy/provisioning/datasources/augur.yaml`:

    ```yaml
    url: https://litellm.example.internal
    jsonData:
      authMethod: apiKey
      apiKeyHeader: authorization
      defaultModel: claude-sonnet-5-5     # a model name your proxy exposes
    secureJsonData:
      apiKey: $ANTHROPIC_API_KEY          # your LiteLLM virtual key
    ```

## 3. Start it

```bash
docker compose -f deploy/docker-compose.yaml up
```

Open <http://localhost:3000> (admin / admin), then **Augur** in the main menu.

## 4. Try it

- *"What's the slowest service right now and why?"*
- Switch to **Investigate** and try *"Checkout errors spiked in the last hour. Find the cause."*
- *"Build a RED dashboard for the checkout service."* Watch the live preview, then ask for changes.

!!! info "Why `/data/grafana/plugins`?"
    The `grafana/otel-lgtm` image sets `GF_PATHS_PLUGINS=/data/grafana/plugins` in its startup script, overriding anything set in the compose file. The demo mounts the plugins there.

## Next steps

- [Install in your own Grafana](install.md)
- [Configure the model datasource](../configure/datasource.md)
