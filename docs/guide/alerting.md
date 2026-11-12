# Alerts and silences

Augur reads alerting freely and drafts changes for you to create.

## Reading

- *"What's firing?"*, *"Why did HighErrorRate fire last night?"*: `list_alerts` and `alert_state_history`.
- *"Which silences are active?"*: `list_silences`.
- From an alert rule or instance: **Investigate with Augur** starts an investigation with the alert as context.

## Silences

> *"Silence the disk alerts on db-3 for 2 hours, we're replacing the volume."*

The silence card shows the matchers, the duration and comment, and **the alerts it would silence right now**, so you can see if the matchers are too broad. **Create** makes it in Grafana's Alertmanager as you.

## Alert rules

> *"Alert when checkout's 5xx ratio is above 2% for 10 minutes."*

The alert rule card shows the query, threshold, `for` duration, folder and evaluation group. The query is **evaluated now**, so you see whether it would fire today. **Create** makes a Grafana-managed rule in the chosen folder and group (created if missing).

Augur prefers ratio and rate expressions with explicit windows and a `for` duration, to avoid flapping alerts.

## Permissions

Creating silences and rules uses your own alerting permissions (Editor by default). See [Permissions](../operate/permissions.md).
