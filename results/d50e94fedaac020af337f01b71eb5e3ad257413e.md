# E2E d50e94f (2026-11-13T21:28:41Z)
run: https://github.com/AniAIApps/augur/actions/runs/43508804643
e2e: success
loop-control: success

## e2e
✓ Augur app enabled
✓ Augur datasource backend healthy
✓ models discovered from the endpoint (embeddings filtered)
✓ list_datasources (1ms, 161 chars)
→ query_loki {"datasource_uid":"loki","expr":"{service=\"payment-service\"} |= \"error\"","limit":20}
→ search_traces {"datasource_uid":"tempo","traceql":"{ status = error }","limit":5}
✓ query_prometheus (41ms, 1365 chars)
✓ query_loki (43ms, 985 chars)
✓ query_loki (44ms, 933 chars)
✓ search_traces (44ms, 702 chars)
✓ draft_dashboard (45ms, 595 chars)
✓ headless run exits 0 (got 0, 0.3s)
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
✓ dashboard proposal applied ([{"kind":"dashboard","message":"Saved dashboard \"Augur e2e: service overview\"","url":"/d/cl-w642wm8kgj1/augur-e2e3a-service-overview"}])
✓ evidence ledger has ≥3 entries (6)
✓ dashboard exists in Grafana
✓ dashboard panels have datasources and targets
✓ Loki deployment annotation saved
All checks passed
✓ list_datasources (0ms, 161 chars)
→ query_loki {"datasource_uid":"loki","expr":"{service=\"payment-service\"} |= \"error\"","limit":20}
→ search_traces {"datasource_uid":"tempo","traceql":"{ status = error }","limit":5}
✓ query_prometheus (29ms, 1365 chars)
✓ search_traces (30ms, 702 chars)
✓ query_loki (33ms, 933 chars)
✓ query_loki (33ms, 985 chars)
✓ draft_dashboard (28ms, 595 chars)
✓ headless run exits 0 (got 0, 0.3s)
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
✓ dashboard proposal applied ([{"kind":"dashboard","message":"Saved dashboard \"Augur e2e: service overview\"","url":"/d/cl-42pum6g01hz/augur-e2e3a-service-overview"}])
✓ evidence ledger has ≥3 entries (6)
✓ dashboard exists in Grafana
✓ dashboard panels have datasources and targets
✓ Loki deployment annotation saved
All checks passed
✓ [run 1/5] Augur app page renders with the composer
✓ [run 1/5] scripted run finished in the UI
✓ [run 1/5] model requests from the browser were well-formed
✓ [run 1/5] no tool or gateway errors shown
✓ [run 1/5] transcript scrolls in its own pane, composer visible ({"overflow":"auto","scrolls":true,"composerVisible":true})
✓ [run 1/5] dashboard draft card shown (not applied without a click)
✓ [run 1/5] draft preview renders both panels ({"cells":2,"alerts":0,"canvases":0})
✓ [run 1/5] draft preview panels render without errors
✓ [run 1/5] no page errors
✓ [run 2/5] Augur app page renders with the composer
✓ [run 2/5] scripted run finished in the UI
✓ [run 2/5] model requests from the browser were well-formed
✓ [run 2/5] no tool or gateway errors shown
✓ [run 2/5] transcript scrolls in its own pane, composer visible ({"overflow":"auto","scrolls":true,"composerVisible":true})
✓ [run 2/5] dashboard draft card shown (not applied without a click)
✓ [run 2/5] draft preview renders both panels ({"cells":2,"alerts":0,"canvases":0})
✓ [run 2/5] draft preview panels render without errors
✓ [run 2/5] no page errors
✓ [run 3/5] Augur app page renders with the composer
✓ [run 3/5] scripted run finished in the UI
✓ [run 3/5] model requests from the browser were well-formed
✓ [run 3/5] no tool or gateway errors shown
✓ [run 3/5] transcript scrolls in its own pane, composer visible ({"overflow":"auto","scrolls":true,"composerVisible":true})
✓ [run 3/5] dashboard draft card shown (not applied without a click)
✓ [run 3/5] draft preview renders both panels ({"cells":2,"alerts":0,"canvases":0})
✓ [run 3/5] draft preview panels render without errors
✓ [run 3/5] no page errors
✓ [run 4/5] Augur app page renders with the composer
✓ [run 4/5] scripted run finished in the UI
✓ [run 4/5] model requests from the browser were well-formed
✓ [run 4/5] no tool or gateway errors shown
✓ [run 4/5] transcript scrolls in its own pane, composer visible ({"overflow":"auto","scrolls":true,"composerVisible":true})
✓ [run 4/5] dashboard draft card shown (not applied without a click)
✓ [run 4/5] draft preview renders both panels ({"cells":2,"alerts":0,"canvases":1})
✓ [run 4/5] draft preview panels render without errors
✓ [run 4/5] no page errors
✓ [run 5/5] Augur app page renders with the composer
✓ [run 5/5] scripted run finished in the UI
✓ [run 5/5] model requests from the browser were well-formed
✓ [run 5/5] no tool or gateway errors shown
✓ [run 5/5] transcript scrolls in its own pane, composer visible ({"overflow":"auto","scrolls":true,"composerVisible":true})
✓ [run 5/5] dashboard draft card shown (not applied without a click)
✓ [run 5/5] draft preview renders both panels ({"cells":2,"alerts":0,"canvases":1})
✓ [run 5/5] draft preview panels render without errors
✓ [run 5/5] no page errors
All UI checks passed (5 runs)

## first page error with stack

## loop-control
CONTROL RESULT Without Augur (Grafana pages): 0 update loop(s) in 5 pass(es) of 7 pages; 0 page error(s) total
CONTROL RESULT Without Augur, typing in Grafana's dashboard search: 0 update loop(s) in 5 pass(es) of 1 pages; 0 page error(s) total
CONTROL RESULT Augur installed, idle (Grafana pages): 0 update loop(s) in 5 pass(es) of 7 pages; 0 page error(s) total
CONTROL RESULT Augur page open, no chat: 0 update loop(s) in 5 pass(es) of 1 pages; 0 page error(s) total

## e2e failure diagnostics (tail)
