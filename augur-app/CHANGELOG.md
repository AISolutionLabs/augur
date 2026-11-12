# Changelog

## 1.7.0

A reliability release, following an independent review of 1.6.0.

- **Deleted conversations stay deleted.** Deleting a conversation that was running (model call in flight, approval pending, sub-agents working) could write it back when the run unwound. Deletions are now tombstoned, so no late save, debounced checkpoint or other tab can restore them.
- **One tab per run, atomically.** Run ownership uses the Web Locks API (released automatically if a tab crashes), with a write-then-verify localStorage fallback. Two tabs starting the same conversation at the same instant can no longer both run it.
- **Every continuation is bounded.** Each model response counts toward the step limit, including `pause_turn`; at most three pauses in a row, the token budget is checked after pauses, and a hard cap stops any loop.
- **Backend limits are respected.** A spent daily budget from the datasource is shown at once instead of retried; rate and concurrency limits are retried with backoff.
- **Investigation reports use the right question and window.** Each investigation records its question, start time and the window the agent was given; Save to Grafana, Markdown and PDF use them (widened to cover every query in the evidence ledger) instead of the conversation's first message and creation time.
- **Dashboard revisions don't overwrite other people's changes.** *Update saved dashboard* (and headless revisions) now send the version Augur saved; if the dashboard changed in Grafana since, nothing is overwritten and you're offered *Save as new*. Dashboards saved by 1.6 (no recorded version) can only be saved as new.
- **Switching datasources is race-free.** A slow configuration or MCP catalog response for a previously selected datasource is discarded instead of overwriting the current one.
- **MCP:** calls send the tool's fingerprint; a tool the server redefined since it was listed is refused and the list reloads.
- **Prompt injection:** sub-agent briefs reach the lead agent framed as evidence to verify, never as instructions; the system prompt names trace attributes, dashboard descriptions, runbooks, MCP tool descriptions and briefs as untrusted.
- **History retention.** New org setting *Keep conversations for (days)*: older unpinned conversations are deleted from users' browsers.
- The dashboard preview is labelled as a validation sample (last hour, variables set to all values).
- Provider-neutral wording: "Created with Augur", "model datasource", no "powered by Claude" in the prompt.
- GitHub Actions are pinned to commit SHAs, with Dependabot keeping them current.

## 1.6.0

- **Multiple conversations.** A conversations rail (page) and list (sidebar) with search, rename, pin and delete, grouped by Running, Pinned, Today, Yesterday, Previous 7 days and Older. Switching conversations no longer stops a run: up to three conversations run in parallel in the background, each with its own cross-tab lease; runs waiting for approval or interrupted are marked. Stop affects only the open conversation. History keeps 60 conversations and compacts older transcripts (then long tool outputs) before evicting any.
- **Knows the installed Grafana.** Each run reads the enabled plugins and Grafana version and tells the model which apps (Drilldown, SLO, IRM, k6, Asserts…), datasource types and panel types exist; links point only to installed apps. New `grafana_capabilities` tool for the full list.
- **Dashboard builder overhaul.**
  - Live preview: draft cards render real Grafana panels with the last hour of data (`PanelRenderer`, variables wildcarded, up to 20 panels).
  - Modern panels: legends (table/list, placement, calcs), color schemes, per-series overrides, value/range mappings, data links, repeat-by-variable, threshold lines/areas, stacking, gradient fills; new types state-timeline, status-history, histogram and flame graph (Pyroscope); heatmap-format bucket queries; collapsed rows.
  - Layout: stat runs share a full row, lines fill to 24 columns, heights equalised per line.
  - Lint with automatic fixes: `$__rate_interval` for short rate windows and units inferred from metric names; warnings for raw counters, buckets without `histogram_quantile`, missing `le`, log/metric query mismatches, more than 30 series, and panel types that aren't installed (fallback to time series).
  - `revise_draft`: change only the panels you mention; numbered revisions. **Update saved dashboard** overwrites the dashboard saved from an earlier revision (the headless runner does the same with `AUGUR_APPLY=auto`).
- **PDF export for investigation reports.** A print-ready report (write-up, findings by severity, hypotheses, evidence ledger, queries) printed from a hidden frame; choose *Save as PDF*. No external service or dependency. The Markdown report now includes hypotheses too.
- E2E: the browser pass checks that the dashboard preview renders both panels without errors.

## 1.5.2

- Fix: React error #185 ("maximum update depth exceeded") after typing ~50 characters into the chat box on Grafana 13. Each keystroke re-rendered the whole chat view, including Grafana UI tooltips that also re-render on every keydown, which kept a synchronous update pending after each commit until React aborted. The chat box now keeps its own text, so typing re-renders only the box.
- Repository moved to [AniAIApps/augur](https://github.com/AniAIApps/augur); plugin links updated.
- Chat auto-scroll jumps instead of animating, and only follows new messages while you are at the bottom (it no longer pulls you down while reading earlier output).
- Fewer page re-renders during runs: the session store gives React a stable snapshot and delivers run updates at most once per frame.
- E2E: the browser pass runs 5 times in CI with a React commit probe, and a control experiment (without Augur, Augur idle, Augur page open, typing in Grafana's own search) runs alongside; any update loop during an Augur run fails the test. Results are also published to the `ci-results` branch.
- Augur at the top level of the menu (between Drilldown and Alerting) in the demo and the documented install config (`[navigation.app_sections] augur-assistant-app = root -3450`); CI checks the menu placement.

## 1.5.0

- Model picker shows the models the endpoint offers to you (with display names), instead of a hardcoded list.
- Demo `deploy/docker-compose.yaml`: plugins mounted at `/data/grafana/plugins` (current `grafana/otel-lgtm` overrides `GF_PATHS_PLUGINS`); CI now checks the demo loads both plugins.

## 1.4.0

- Headless runner (`npm run build:headless`): the same agent, tools and prompts outside the browser, against Grafana's HTTP API with a service-account token; model through an Augur datasource or a Messages endpoint directly; ATIF trajectory output; proposals applied only with `AUGUR_APPLY=auto`.
- End-to-end tests on every push: real Grafana 13 + Prometheus/Loki/Tempo with incident data, the built plugins and a scripted stub model; headless runs (direct and through the datasource backend) and a Chrome run of the app page (`make e2e`).
- o11y-bench support: run Augur on Grafana's open observability-agent benchmark next to its default agent (`bench/o11y-bench/run.sh`).
- Dashboards: query annotations (Loki or Prometheus, e.g. deployment markers with version text) in new dashboards (`annotations`) and edits (`add_annotations`).
- Proposal apply logic shared between the UI and the headless runner.
- README: leads with fully self-hosted / own model / no Grafana Cloud; comparison updated for Grafana Assistant on self-managed Grafana (requires a Grafana Cloud stack, Grafana 13.1+).

## 1.3.0

- Evidence ledger: every data query is recorded with datasource, query, absolute time range, SHA-256 digest of the response and frame/row counts; tool results carry evidence ids (`E3`) that findings cite; the ledger is saved with investigations (new dashboard panel) and exported reports.
- Per-run token ceiling (`maxTokensPerRun`, default 1.5M effective tokens, sub-agents included): when reached the run stops querying and answers from what it has.
- Multi-tab safety: a run lease ensures only one tab drives a session; other tabs show *Running in another tab*, can't resume or send, and take over if the owner tab goes away.
- MCP tools are treated as read-only only when the datasource admin says so (`augurReadOnly` from the backend); MCP servers' own `readOnlyHint` is no longer trusted.
- Prompts: findings must cite evidence ids; summaries can hide rare events, so query directly for them.
- New SECURITY.md describing trust boundaries, what is enforced where, prompt-injection stance and reporting.

## 1.2.0

- Durable runs: the agent runs outside React, so investigations survive closing the sidebar and navigating Grafana; transcript checkpointed after every step with **Resume** after reload or crash; transient gateway errors retried with backoff; leave-page confirmation while running.
- Context management: token-based budget with tiered compaction, automatic recovery from "prompt too long", near-duplicate log lines collapsed into counted groups.
- Toolsets: sub-agents can use MCP tools annotated read-only (never ones that need approval); proposal tools are offered only when a UI can show proposals, and fail loudly otherwise; MCP tool names that collide after sanitising/truncation get a stable hash suffix instead of being dropped.
- Prompts: investigations get a reminder after 4 rounds of queries without updating findings/hypotheses; the user's timezone (Grafana preference or browser) is injected so reports show local time and relative age next to UTC; queries and template variables must be written in code spans/blocks (Grafana's Markdown otherwise turns `__name__` into bold).
- Fix: abort listeners are removed when requests, backoff sleeps and approval prompts settle (no accumulation on long investigations); retry backoff has ±50% jitter so parallel sub-agents don't retry in lockstep; MCP discovery errors and warnings shown in the chat.
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
