# Install in your Grafana

Augur needs **Grafana 12.0 or later**, OSS or Enterprise. The same build runs on 12.x and 13.x, on Linux, macOS and Windows (amd64 and arm64).

## 1. Download the plugins

From [Releases](https://github.com/AniAIApps/augur/releases), download both:

- `augur-assistant-app-<version>.zip`: the app (UI and agent)
- `augur-claude-datasource-<version>.zip`: the datasource (model and MCP proxy)

Verify them:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify augur-assistant-app-<version>.zip --repo AniAIApps/augur   # optional: build provenance
```

## 2. Unzip into the plugins directory

Unzip both into Grafana's plugins directory: `plugins` under `[paths]` in `grafana.ini`, or `GF_PATHS_PLUGINS`. The default is `/var/lib/grafana/plugins`.

```bash
sudo unzip augur-assistant-app-<version>.zip -d /var/lib/grafana/plugins
sudo unzip augur-claude-datasource-<version>.zip -d /var/lib/grafana/plugins
```

## 3. Configure Grafana

Add to `grafana.ini` (or `custom.ini`):

```ini
[plugins]
# Not needed if you signed the plugins yourself (see Plugin signing)
allow_loading_unsigned_plugins = augur-assistant-app,augur-claude-datasource

[navigation.app_sections]
# Top level of the menu, between Drilldown and Alerting
augur-assistant-app = root -3450
```

??? question "Why the navigation setting?"
    Plugins can't choose their own menu section. Without this setting Grafana puts Augur under **More apps**. Other sections: `explore`, `alerts-and-incidents`, `observability`, `infrastructure`. A lower weight moves it up: Dashboards -3700, Explore -3600, Drilldown -3500, Alerting -3300.

    `navigation.app_sections` must be in `grafana.ini`. `GF_*` environment variables can't add entries to it.

## 4. Restart and enable

1. Restart Grafana.
2. **Administration → Plugins and data → Plugins → Augur → Enable.**
3. **Connections → Data sources → Add data source → Claude (Augur).** Set the URL and credentials of your model endpoint, then **Save & test**. See [Model datasource](../configure/datasource.md).
4. Open **Augur** from the menu.

## Provisioning instead of clicking

```yaml title="provisioning/plugins/augur.yaml"
apiVersion: 1
apps:
  - type: augur-assistant-app
    org_id: 1
    disabled: false
```

```yaml title="provisioning/datasources/augur.yaml"
apiVersion: 1
datasources:
  - name: Claude
    uid: claude
    type: augur-claude-datasource
    url: https://litellm.example.internal
    jsonData:
      authMethod: apiKey
      apiKeyHeader: authorization
      defaultModel: claude-sonnet-5-5
    secureJsonData:
      apiKey: ${LITELLM_KEY}
```

## The docked sidebar

On Grafana versions with the extension sidebar, Augur docks beside every page. On older versions, every entry point (panel menu, Explore, alerts, command palette) opens the full Augur page instead.

## Upgrading

Replace both plugin folders with the new release and restart Grafana. Settings, rules, skills and saved investigations are kept, since they live in Grafana's database. Conversations live in each user's browser and are kept too.
