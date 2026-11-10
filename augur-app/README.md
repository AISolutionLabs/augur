# Augur

AI investigations for Grafana, powered by Claude.

- **Chat** with your metrics (Prometheus/Mimir), logs (Loki), traces (Tempo), dashboards, alerts and annotations.
- **Investigate** incidents. Augur runs a structured root-cause analysis across every signal, records findings as it goes, and writes an exportable report with the evidence and the queries behind it.
- **Act with approval**: build or edit dashboards, draft silences and alert rules, all applied only by you.
- **Team knowledge**: rules, runbook skills (`/commands`), infrastructure memory, past investigations, and MCP server tools.
- **Build dashboards** from plain language. Queries are checked against your data before you see the draft, and the draft is saved as a new dashboard only when you click Save.

Queries run as the signed-in user, so Grafana permissions apply. Model calls go through the **Claude (Augur)** datasource (`augur-claude-datasource`), which this app requires. Configure it with a gateway API key (LiteLLM, Anthropic) or have it forward each user's OAuth/OIDC token.

Entry points: the docked **sidebar** on any page (where Grafana provides the extension sidebar), the **Augur** nav item, *Ask Claude about this panel* / *Investigate with Claude* in the panel menu, *Investigate with Claude* on alert rules, and *Ask Claude* in the command palette.

Requires Grafana 12.0+. Docs and source: https://github.com/AniAIApps/augur

Grafana is a trademark of Grafana Labs, and Claude is a trademark of Anthropic. Augur is an independent open-source project, not affiliated with or endorsed by either company.
