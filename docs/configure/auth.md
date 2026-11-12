# Authentication and OAuth

The datasource authenticates to your model endpoint in one of three ways.

| Method | Sends | Use when |
|---|---|---|
| **API key** | One key stored encrypted in Grafana | A shared gateway key (LiteLLM virtual key, Anthropic key) is fine |
| **Forward OAuth token** | Each signed-in user's own OAuth/OIDC token | The gateway should know who is asking (per-user budgets, audit, team routing) |
| **None** | No auth header | Network-level or mTLS auth |

## API key

The key is stored in `secureJsonData` (encrypted in Grafana's database) and added by the backend. Browser-supplied `Authorization`, `x-api-key` and `api-key` headers are always dropped, and **Extra headers** can't override auth.

Pick the header your endpoint expects: `Authorization: Bearer` (LiteLLM, OpenAI), `x-api-key` (Anthropic) or `api-key` (Azure OpenAI).

## Forward OAuth token

Users must sign in to Grafana through OAuth/OIDC (Entra ID, Okta, Keycloak, Google…). Grafana forwards the user's token to datasource plugins that ask for it, which is why the model connection is a datasource and not part of the app.

```yaml
jsonData:
  authMethod: oauth
  oauthPassThru: true        # required for Grafana to forward the token
  oauthTokenType: access     # access (Authorization header) or id (OIDC ID token)
```

**Augur forwards; it doesn't authorize.** Your gateway must validate the token's signature (JWKS), issuer, audience and expiry, and map claims to permissions. If a request has no token, it fails with **401**. Augur never falls back to a shared key.

### Entra ID and LiteLLM

The access token Grafana gets is issued for Grafana's scopes. For LiteLLM to accept it, choose one:

=== "Access token for the gateway (recommended)"

    Register the gateway as an app in Entra ID with an exposed API scope, and add that scope to Grafana's login scopes so the access token's audience is the gateway:

    ```ini
    [auth.azuread]
    scopes = openid email profile offline_access api://<litellm-app-id>/.default
    ```

    Set `oauthTokenType: access`.

=== "ID token"

    Forward the OIDC ID token instead (`oauthTokenType: id`). Its audience is Grafana's client ID, so configure the gateway to accept that audience.

Then configure LiteLLM's JWT auth against your tenant's JWKS (`https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`) and map claims (groups, roles, `oid`) to teams and budgets.

!!! warning "Token lifetime"
    Long investigations can outlive an access token. Include `offline_access` so Grafana can refresh it; otherwise a run may fail with 401 midway. Click **Resume** after signing in again.

### MCP servers

MCP servers can also receive the user's token (`auth: oauth`). The same rule applies: the MCP server must validate it. See [MCP servers](mcp.md).

## Who can use Augur

Anyone who can **query** the Augur datasource can use Augur. Restrict it with Grafana's datasource permissions (Enterprise and Cloud) or by organization. See [Permissions](../operate/permissions.md).
