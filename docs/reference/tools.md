# Tools

The tools the model can call. Tools that only read run freely within your permissions; everything that changes state is a **proposal** you apply.

| Area | Tools |
|---|---|
| Discovery | `grafana_capabilities`, `list_datasources`, `search_dashboards`, `get_dashboard`, `list_folders`, `get_infrastructure_memory` |
| Metrics | `prometheus_metric_names`, `prometheus_labels`, `query_prometheus` |
| Logs | `loki_labels`, `query_loki`, `loki_patterns` |
| Traces | `tempo_tag_values`, `search_traces`, `get_trace` |
| Profiles | `query_profiles` (Pyroscope: hottest functions by self and total time) |
| Grafana | `run_panel_queries`, `list_alerts`, `alert_state_history`, `get_annotations`, `list_silences` |
| Knowledge | `search_skills`, `read_skill`, `search_past_investigations`, `read_past_investigation` |
| Investigation | `delegate` (parallel sub-agents), `update_hypothesis`, `record_finding` |
| Proposals (you apply) | `draft_dashboard`, `revise_draft`, `propose_dashboard_edit`, `draft_silence`, `draft_alert_rule` |
| MCP | `mcp__<server>__<tool>` for each allowed tool of your [MCP servers](../configure/mcp.md) |

## Knowing your Grafana

`grafana_capabilities` lists the installed and enabled apps, datasource plugins and panel plugins with versions, plus the Grafana version. A summary is in every run's system prompt, so Augur links to *Metrics Drilldown*, *Logs Drilldown*, SLO or IRM only when they're installed.

## Sub-agents

Sub-agents started with `delegate` get a read-only subset: no proposals, no non-read-only MCP tools, no hypotheses, and no further delegation.

## Evidence ids

Every data query result carries an evidence id (`E1`, `E2`…) from the [evidence ledger](../guide/reports.md#the-evidence-ledger). Findings and reports cite them.
