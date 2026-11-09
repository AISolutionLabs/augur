# Changelog

## 1.2.0

- Durable runs: the agent runs outside React, so investigations survive closing the sidebar and navigating Grafana; transcript checkpointed after every step with **Resume** after reload or crash; transient gateway errors retried with backoff; leave-page confirmation while running.
- Context management: token-based budget with tiered compaction, automatic recovery from "prompt too long", near-duplicate log lines collapsed into counted groups.
- Fix: single-sample summaries (instant queries, alert-rule previews) failed on multi-point series.
- UI: finding rows no longer duplicated by their tool rows; clearer silence duration.
- README: screenshots/GIF of the real UI, quick start, investigation architecture, context management, durability and model support.

## 1.1.0

- Grafana 12.0+ support (in addition to 13.x).
- Docked sidebar on every page (extension sidebar), aware of the dashboard/Explore/alert you are viewing; panel, Explore, alert and command-palette entry points open it, falling back to the app page where the sidebar is unavailable.
- Rules (org-wide and personal) and Skills (runbooks discovered at runtime or run as `/commands`), managed in the app settings or provisioned from Git.
- Infrastructure memory: deterministic scan of Prometheus/Mimir, Loki, Tempo (incl. service graph) and Pyroscope.
- Investigations: parallel specialist sub-agents, hypothesis board, conclusion gate that challenges the leading hypothesis, save to Grafana as a permissioned dashboard with evidence panels and annotations, search past investigations.
- Actions (user-approved): edit existing dashboards with a change list and version guard, draft silences with live match preview, draft alert rules evaluated before creation.
- Pyroscope profiles tool; Explore/dashboard/alert deep links in every answer.
- MCP server tools via the datasource backend, with approval for non-read-only tools.
- Conversation history per browser.

## 1.0.0

Initial release.
