# Kubernetes and Helm

With the [Grafana Helm chart](https://github.com/grafana/helm-charts/tree/main/charts/grafana), install the plugins from the release zips and put the settings under `grafana.ini`.

## Values

```yaml title="values.yaml"
plugins:
  - https://github.com/AniAIApps/augur/releases/download/v1.8.0/augur-assistant-app-1.8.0.zip;augur-assistant-app
  - https://github.com/AniAIApps/augur/releases/download/v1.8.0/augur-claude-datasource-1.8.0.zip;augur-claude-datasource

grafana.ini:
  plugins:
    allow_loading_unsigned_plugins: augur-assistant-app,augur-claude-datasource
  navigation.app_sections:
    augur-assistant-app: root -3450

# Internal CA for the model gateway and MCP servers
extraConfigmapMounts:
  - name: internal-ca
    configMap: internal-ca          # contains ca.pem
    mountPath: /etc/ssl/internal
    readOnly: true

datasources:
  augur.yaml:
    apiVersion: 1
    datasources:
      - name: Claude
        uid: claude
        type: augur-claude-datasource
        url: https://litellm.platform.svc.cluster.local:4000
        jsonData:
          authMethod: apiKey
          apiKeyHeader: authorization
          defaultModel: claude-sonnet-5-5
          tlsCACertFile: /etc/ssl/internal/ca.pem
        secureJsonData:
          apiKey: $__file{/etc/secrets/litellm/key}
```

!!! tip "Air-gapped or restricted egress"
    If Grafana pods can't reach GitHub, mirror the zips into your artifact store (Artifactory, Nexus, S3) and point `plugins:` at the mirror, or bake them into an image:

    ```dockerfile
    FROM grafana/grafana:13.0.0
    COPY augur-assistant-app /var/lib/grafana/plugins/augur-assistant-app
    COPY augur-claude-datasource /var/lib/grafana/plugins/augur-claude-datasource
    ```

## Secrets

Keep the gateway key out of values files. Mount it from a Kubernetes Secret (or External Secrets / Vault) and reference it with `$__file{...}` or an environment variable (`$LITELLM_KEY`) in the provisioning file.

## Network access the Grafana pod needs

| From | To | Why |
|---|---|---|
| Grafana server | Model endpoint (LiteLLM, Anthropic, Azure OpenAI…) | Model calls (the datasource backend) |
| Grafana server | MCP servers (optional) | Tool calls |
| Browser | Grafana only | The app talks only to Grafana |

The browser never calls the model directly, so you don't need to open egress from user machines.

## Running more than one replica

Augur keeps no server-side state besides Grafana's own database (plugin settings, dashboards). Runs execute in the user's browser, so any number of Grafana replicas works behind a load balancer.
