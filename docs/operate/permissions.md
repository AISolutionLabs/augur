# Permissions

Augur has no permissions of its own. Everything runs **as the signed-in user** through Grafana's APIs, so Grafana RBAC decides what Augur can see and do for each person.

| Action | Permission needed |
|---|---|
| Use Augur | Query the Augur datasource |
| Query metrics, logs, traces, profiles | Query those datasources |
| Read dashboards, alerts, annotations | Read access to them |
| Save a new dashboard or investigation | Create in the target folder |
| Apply a dashboard edit | Edit that dashboard |
| Create silences and alert rules | Alerting silence and rule create permissions (Editor by default) |
| Call MCP tools that aren't read-only | The server's `writeRole` (default Editor) and an **Allow once** click |
| Change org rules, skills, memory and settings | Org admin |

## Limiting who can use Augur

- **Datasource permissions** (Grafana Enterprise and Cloud): grant *Query* on the Augur datasource to a team.
- **Several datasources**: for example a cheap model for everyone and the strongest one for the SRE team, each with its own key and budget at the gateway.
- **Forwarded OAuth tokens**: the gateway decides per user (see [Authentication](../configure/auth.md)).

## Service accounts

The [headless runner](headless.md) uses a Grafana service-account token, and that account's permissions apply. Give it Viewer for read-only checks; it needs Editor only if it applies proposals (`AUGUR_APPLY=auto`).
