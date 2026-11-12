# Building dashboards

Ask for a dashboard in plain language. Augur designs it, dry-runs every query, and shows you a **live preview** on real data. Nothing is saved until you click.

> *"Build a RED dashboard for the checkout service with a section for Kafka consumers."*

## The draft card

- **Preview:** the dashboard rendered with real Grafana panels and the last hour of data, with dashboard variables set to all values. Toggle **Outline** for a text summary. Collapsed rows show as headers; drafts larger than 20 panels preview the first 20.
- **Revision number:** each change you ask for makes a new revision. Older drafts are marked superseded.
- **Query check:** how many queries returned data, and which were empty or failed.
- **Automatic fixes:** what Augur corrected for you (see below).
- **Warnings:** problems worth a look before saving.
- **Folder**, **Save as new dashboard**, **JSON** and **Copy JSON**.

## Iterating

Ask for changes in the conversation:

- *"Make the latency panel a heatmap."*
- *"Add a breakdown by pod under Saturation, collapsed."*
- *"Remove the logs panel and add a variable for namespace."*

Augur calls `revise_draft`, which changes only the panels you mention and leaves the rest as they were.

If you saved an earlier revision, the card offers **Update saved dashboard**, which overwrites the one you saved, or **Save as new**, which keeps both. Dashboard versions in Grafana keep every save restorable.

## What the builder produces

- **Panel types:** time series, stat, gauge, bar gauge, bar chart, pie chart, table, heatmap, logs, traces, text, state timeline, status history, histogram and flame graph. Types not installed in your Grafana fall back to time series with a warning.
- **Modern defaults:** gradient fills and smooth lines; table legends with mean, max and last; stat rows spread across the full width; thresholds as lines or areas.
- **Options:** units, decimals, min/max, color schemes, per-series overrides (color, axis, unit, draw style, fill, dashed lines, stacking, hiding, display name), value and range mappings, data links, repeat by variable, descriptions.
- **Layout:** rows (optionally collapsed), panels filling the 24-column grid, equal heights within a line.
- **Variables and annotations:** query and custom variables, datasource variables, and query annotations such as deploy markers from Loki.
- **Queries:** Prometheus/Mimir, Loki, Tempo (TraceQL) and Pyroscope (flame graphs).

## Automatic fixes and warnings

| Check | What happens |
|---|---|
| Short fixed rate window (`rate(x[5m])`) | Changed to `$__rate_interval` |
| No unit | Inferred from the metric: `_seconds` → s, `_bytes` → bytes or B/s, `_total` rate → req/s or ops/s, error ratios → percent |
| Counter without `rate()` | Warning |
| Histogram buckets without `histogram_quantile` (outside heatmaps) | Warning |
| `histogram_quantile` without `le` in the `by` clause | Warning |
| Log query in a metric panel, or metric query in a logs panel | Warning |
| More than 30 series in a panel | Warning, with a suggestion to aggregate |
| Empty or failing query (dry-run over the last hour) | Reported to you and to the model, which usually fixes it |

## Editing existing dashboards

*"Add a p95 panel to the Checkout dashboard"* produces an **edit proposal** with a change list: panels added, changed and removed, variables and annotations. **Apply changes** saves a new version using Grafana's version check, so if someone else saved in the meantime, nothing is overwritten. Roll back from the dashboard's version history.
