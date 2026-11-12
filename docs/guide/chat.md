# Chat and entry points

## Where to find Augur

| Where | What |
|---|---|
| **Main menu → Augur** | The full page, with the conversations rail |
| **Sidebar** | Docked beside any Grafana page (Grafana's extension sidebar). Augur knows the page you're on: the dashboard, the Explore query, the alert. |
| **Panel menu** | *Ask Augur about this panel*, *Investigate with Augur* |
| **Explore toolbar** | *Ask Augur* about the current query |
| **Alert rules and instances** | *Investigate with Augur* |
| **Command palette** (++ctrl+k++ / ++cmd+k++) | *Ask Augur* |

## The chat header

- **Datasource** and **Model**: which Augur datasource and model to use (when you have more than one).
- **Time range**: the default window Augur queries, for example the last hour.
- **Chat / Investigate**: plain chat, or a structured investigation (see [Investigations](investigations.md)).

## Asking good questions

Augur works out queries itself, but specifics help:

- Name the service, environment or symptom: *"p95 latency for checkout in prod jumped at 14:20. Why?"*
- Ask for an artifact: *"Build a dashboard for…"*, *"Write an alert for…"*, *"Silence the disk alerts on db-3 for 2 hours."*
- Ask it to explain: *"What does this PromQL do?"*, *"Why is this panel empty?"*

Every claim about data links to the query behind it. Click through to Explore to check it.

## Slash commands

Type `/` to see your organization's [skills](../configure/app-settings.md#skills). `/kafka-lag orders-topic` runs that runbook with `orders-topic` as input.

## What Augur can and can't do on its own

Augur reads freely within your permissions: queries, dashboards, alerts, annotations, silences. It **never changes anything by itself**. Dashboards, edits, silences and alert rules come back as proposal cards that you apply with a click, using your own permissions. MCP tools that change things need your role and an **Allow once** click.

## Stopping and resuming

**Stop** ends the run in the open conversation. If the tab reloads or crashes mid-run, the conversation reopens with **Resume**, which continues from the last checkpoint.
