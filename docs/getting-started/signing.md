# Plugin signing

Grafana refuses unsigned plugins unless they are explicitly allowed. You have two options for Augur.

## Option 1: allow the unsigned plugins

```ini
[plugins]
allow_loading_unsigned_plugins = augur-assistant-app,augur-claude-datasource
```

Grafana loads them and shows them as **unsigned** in the plugin list. Signatures guard against tampering, so pair this with the integrity checks on the download:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify augur-claude-datasource-<version>.zip --repo AniAIApps/augur
```

## Option 2: sign them for your own Grafana (private signature)

A **private** signature is free and needs no review from Grafana Labs. It is valid only for the Grafana root URLs you sign for, and private plugins can't be distributed to others or listed in the catalog.

1. Create a free [Grafana Cloud](https://grafana.com/) account. Its organization name becomes the signer; no Grafana Cloud stack is used.
2. Create an **Access Policy token** with the `plugins:write` scope.
3. Sign each built plugin for the exact `root_url` values of your Grafana instances:

    ```bash
    export GRAFANA_ACCESS_POLICY_TOKEN=glc_...
    cd augur-app/dist
    npx @grafana/sign-plugin@latest --rootUrls https://grafana.example.com,https://grafana-staging.example.com
    cd ../../augur-datasource/dist
    npx @grafana/sign-plugin@latest --rootUrls https://grafana.example.com,https://grafana-staging.example.com
    ```

The root URLs must match Grafana's `root_url` setting exactly, including scheme and path.

### Signing in the release workflow

The release workflow signs automatically when the repository has:

| Kind | Name | Value |
|---|---|---|
| Secret | `GRAFANA_ACCESS_POLICY_TOKEN` | the access policy token |
| Variable | `GRAFANA_SIGN_ROOT_URLS` | comma-separated root URLs (private signature) |

Without the secret, unsigned builds are published.

## Community signature

A community signature (installable from Grafana's plugin catalog by anyone) needs a review by Grafana Labs and publication in the catalog. Augur isn't submitted for that today. For use inside one organization, a private signature gives the same protection.
