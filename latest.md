# E2E f1263f4 (2026-11-10T23:34:12Z)
run: https://github.com/AniAIApps/augur/actions/runs/42922675917
e2e: success
loop-control: success

## e2e
✓ Augur app enabled
✓ Augur datasource backend healthy
✓ models discovered from the endpoint (embeddings filtered)
✓ list_datasources (0ms, 161 chars)
→ query_loki {"datasource_uid":"loki","expr":"{service=\"payment-service\"} |= \"error\"","limit":20}
→ search_traces {"datasource_uid":"tempo","traceql":"{ status = error }","limit":5}
✓ query_prometheus (32ms, 1365 chars)
✓ query_loki (32ms, 933 chars)
✓ query_loki (33ms, 985 chars)
✓ search_traces (34ms, 702 chars)
✓ draft_dashboard (23ms, 548 chars)
✓ headless run exits 0 (got 0, 0.2s)
✓ model requests well-formed
✓ run reached the final answer
✓ tool calls recorded in ATIF trajectory (6)
✓ list_datasources succeeded
✓ query_prometheus succeeded
✓ query_loki succeeded
✓ query_loki succeeded
✓ search_traces succeeded
✓ draft_dashboard succeeded
✓ list_datasources sees Prometheus, Loki and Tempo
✓ Prometheus query returned real series
✓ Prometheus result carries an evidence id
✓ Loki metric query returned level series
✓ Loki log query returned error lines
✓ Tempo search returned trace ids
✓ dashboard proposal applied ([{"kind":"dashboard","message":"Saved dashboard \"Augur e2e: service overview\"","url":"/d/cl-nk3ozqtolbw/augur-e2e3a-service-overview"}])
✓ evidence ledger has ≥3 entries (6)
✓ dashboard exists in Grafana
✓ dashboard panels have datasources and targets
✓ Loki deployment annotation saved
All checks passed
✓ list_datasources (0ms, 161 chars)
→ query_loki {"datasource_uid":"loki","expr":"{service=\"payment-service\"} |= \"error\"","limit":20}
→ search_traces {"datasource_uid":"tempo","traceql":"{ status = error }","limit":5}
✓ query_prometheus (24ms, 1365 chars)
✓ search_traces (23ms, 702 chars)
✓ query_loki (32ms, 933 chars)
✓ query_loki (32ms, 985 chars)
✓ draft_dashboard (24ms, 548 chars)
✓ headless run exits 0 (got 0, 0.2s)
✓ model requests well-formed
✓ run reached the final answer
✓ tool calls recorded in ATIF trajectory (6)
✓ list_datasources succeeded
✓ query_prometheus succeeded
✓ query_loki succeeded
✓ query_loki succeeded
✓ search_traces succeeded
✓ draft_dashboard succeeded
✓ list_datasources sees Prometheus, Loki and Tempo
✓ Prometheus query returned real series
✓ Prometheus result carries an evidence id
✓ Loki metric query returned level series
✓ Loki log query returned error lines
✓ Tempo search returned trace ids
✓ dashboard proposal applied ([{"kind":"dashboard","message":"Saved dashboard \"Augur e2e: service overview\"","url":"/d/cl-4per4u1m2uf/augur-e2e3a-service-overview"}])
✓ evidence ledger has ≥3 entries (6)
✓ dashboard exists in Grafana
✓ dashboard panels have datasources and targets
✓ Loki deployment annotation saved
All checks passed
✓ [run 1/5] Augur app page renders with the composer
✓ [run 1/5] scripted run finished in the UI
✓ [run 1/5] model requests from the browser were well-formed
✓ [run 1/5] no tool or gateway errors shown
✓ [run 1/5] dashboard draft card shown (not applied without a click)
✓ [run 1/5] no page errors
✓ [run 2/5] Augur app page renders with the composer
[run 2/5] ⚠ update loop in Grafana's own UI (no Augur components involved):
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 732ms, 0 scroll events; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, ?@testid=data-testid Nav menu item×60, TruncatedText@testid=data-testid Nav menu item×60]
✓ [run 2/5] scripted run finished in the UI
✓ [run 2/5] model requests from the browser were well-formed
✓ [run 2/5] no tool or gateway errors shown
✓ [run 2/5] dashboard draft card shown (not applied without a click)
✓ [run 2/5] no page errors
✓ [run 3/5] Augur app page renders with the composer
[run 3/5] ⚠ update loop in Grafana's own UI (no Augur components involved):
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 735ms, 0 scroll events; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60]
✓ [run 3/5] scripted run finished in the UI
✓ [run 3/5] model requests from the browser were well-formed
✓ [run 3/5] no tool or gateway errors shown
✓ [run 3/5] dashboard draft card shown (not applied without a click)
✓ [run 3/5] no page errors
✓ [run 4/5] Augur app page renders with the composer
[run 4/5] ⚠ update loop in Grafana's own UI (no Augur components involved):
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 732ms, 0 scroll events; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, ?@testid=data-testid Nav menu item×60, TruncatedText@testid=data-testid Nav menu item×60]
✓ [run 4/5] scripted run finished in the UI
✓ [run 4/5] model requests from the browser were well-formed
✓ [run 4/5] no tool or gateway errors shown
✓ [run 4/5] dashboard draft card shown (not applied without a click)
✓ [run 4/5] no page errors
✓ [run 5/5] Augur app page renders with the composer
[run 5/5] ⚠ update loop in Grafana's own UI (no Augur components involved):
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 732ms, 0 scroll events; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60]
✓ [run 5/5] scripted run finished in the UI
✓ [run 5/5] model requests from the browser were well-formed
✓ [run 5/5] no tool or gateway errors shown
✓ [run 5/5] dashboard draft card shown (not applied without a click)
✓ [run 5/5] no page errors
⚠ 4 update loop(s) in Grafana's own UI during 5 run(s); not counted as Augur failures.
All UI checks passed (5 runs)

## loop-control
CONTROL RESULT Without Augur (Grafana pages): 0 update loop(s) in 5 pass(es) of 7 pages; 0 page error(s) total
CONTROL RESULT Augur installed, idle (Grafana pages): 0 update loop(s) in 5 pass(es) of 7 pages; 0 page error(s) total

## e2e failure diagnostics (tail)
