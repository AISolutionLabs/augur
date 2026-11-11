# E2E 027f43d (2026-11-11T00:08:59Z)
run: https://github.com/AniAIApps/augur/actions/runs/42927180602
e2e: failure
loop-control: success

## e2e
✓ Augur app enabled
✓ Augur datasource backend healthy
✓ models discovered from the endpoint (embeddings filtered)
✓ list_datasources (0ms, 161 chars)
→ query_loki {"datasource_uid":"loki","expr":"{service=\"payment-service\"} |= \"error\"","limit":20}
→ search_traces {"datasource_uid":"tempo","traceql":"{ status = error }","limit":5}
✓ query_prometheus (43ms, 1365 chars)
✓ query_loki (51ms, 933 chars)
✓ search_traces (50ms, 702 chars)
✓ query_loki (51ms, 985 chars)
✓ draft_dashboard (29ms, 548 chars)
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
✓ dashboard proposal applied ([{"kind":"dashboard","message":"Saved dashboard \"Augur e2e: service overview\"","url":"/d/cl-zwu3n665zch/augur-e2e3a-service-overview"}])
✓ evidence ledger has ≥3 entries (6)
✓ dashboard exists in Grafana
✓ dashboard panels have datasources and targets
✓ Loki deployment annotation saved
All checks passed
✓ list_datasources (0ms, 161 chars)
→ query_loki {"datasource_uid":"loki","expr":"{service=\"payment-service\"} |= \"error\"","limit":20}
→ search_traces {"datasource_uid":"tempo","traceql":"{ status = error }","limit":5}
✓ query_prometheus (20ms, 1365 chars)
✓ query_loki (23ms, 933 chars)
✓ search_traces (25ms, 702 chars)
✓ query_loki (27ms, 985 chars)
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
✓ dashboard proposal applied ([{"kind":"dashboard","message":"Saved dashboard \"Augur e2e: service overview\"","url":"/d/cl-ta7eylf8e1h/augur-e2e3a-service-overview"}])
✓ evidence ledger has ≥3 entries (6)
✓ dashboard exists in Grafana
✓ dashboard panels have datasources and targets
✓ Loki deployment annotation saved
All checks passed
✓ [run 1/5] Augur app page renders with the composer
[run 1/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
✓ [run 1/5] scripted run finished in the UI
✓ [run 1/5] model requests from the browser were well-formed
✓ [run 1/5] no tool or gateway errors shown
✓ [run 1/5] dashboard draft card shown (not applied without a click)
✗ [run 1/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 232ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, ?@testid=data-testid Nav menu item×60, TruncatedText@testid=data-testid Nav menu item×60, Tooltip@aria=Undock menu×60, a@×60; augur components updated: Tooltip@testid=data-testid radio-button-option chat (augur)×60, Tooltip@testid=data-testid radio-button-option investigate (augur)×60, D@testid=input-wrapper (augur)×60, Tooltip@aria=History (augur)×60, Tooltip@aria=New conversation (augur)×60, Tooltip@aria=My preferences (augur)×60]
✓ [run 2/5] Augur app page renders with the composer
[run 2/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
✓ [run 2/5] scripted run finished in the UI
✓ [run 2/5] model requests from the browser were well-formed
✓ [run 2/5] no tool or gateway errors shown
✓ [run 2/5] dashboard draft card shown (not applied without a click)
✗ [run 2/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 761ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×54, Tooltip@aria=New conversation (augur)×54, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51, ?@aria=History (augur)×51, Tooltip@aria=History (augur)×51]
✓ [run 3/5] Augur app page renders with the composer
[run 3/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
✓ [run 3/5] scripted run finished in the UI
✓ [run 3/5] model requests from the browser were well-formed
✓ [run 3/5] no tool or gateway errors shown
✓ [run 3/5] dashboard draft card shown (not applied without a click)
✗ [run 3/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 748ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×57, Tooltip@aria=New conversation (augur)×57, Tooltip@aria=My preferences (augur)×55, Tooltip@aria=History (augur)×52, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51]
✓ [run 4/5] Augur app page renders with the composer
[run 4/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
✓ [run 4/5] scripted run finished in the UI
✓ [run 4/5] model requests from the browser were well-formed
✓ [run 4/5] no tool or gateway errors shown
✓ [run 4/5] dashboard draft card shown (not applied without a click)
✗ [run 4/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 751ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60; augur components updated: Tooltip@aria=New conversation (augur)×57, Tooltip@testid=data-testid radio-button-option investigate (augur)×56, Tooltip@aria=History (augur)×54, Tooltip@aria=My preferences (augur)×52, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51]
✓ [run 5/5] Augur app page renders with the composer
[run 5/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
✓ [run 5/5] scripted run finished in the UI
✓ [run 5/5] model requests from the browser were well-formed
✓ [run 5/5] no tool or gateway errors shown
✓ [run 5/5] dashboard draft card shown (not applied without a click)
✗ [run 5/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 749ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×57, Tooltip@aria=New conversation (augur)×57, Tooltip@aria=History (augur)×53, Tooltip@aria=My preferences (augur)×53, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51]
5 UI check(s) failed

## loop-control
CONTROL RESULT Without Augur (Grafana pages): 0 update loop(s) in 5 pass(es) of 7 pages; 0 page error(s) total
CONTROL RESULT Augur installed, idle (Grafana pages): 0 update loop(s) in 5 pass(es) of 7 pages; 0 page error(s) total
CONTROL RESULT Augur page open, no chat: 0 update loop(s) in 5 pass(es) of 1 pages; 0 page error(s) total

## e2e failure diagnostics (tail)
        at Di (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27354)
        at _o (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60751)
        at fo (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60349)
        at onChange (http://localhost:3000/public/plugins/augur-assistant-app/592.js?_cache=da1fa96f7f1b0d07670e:1:48201)
        at Xh (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:130645)
        at <anonymous> (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:136006)
    loop probe: 60 commits in 232ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, ?@testid=data-testid Nav menu item×60, TruncatedText@testid=data-testid Nav menu item×60, Tooltip@aria=Undock menu×60, a@×60; augur components updated: Tooltip@testid=data-testid radio-button-option chat (augur)×60, Tooltip@testid=data-testid radio-button-option investigate (augur)×60, D@testid=input-wrapper (augur)×60, Tooltip@aria=History (augur)×60, Tooltip@aria=New conversation (augur)×60, Tooltip@aria=My preferences (augur)×60
✓ [run 1/5] scripted run finished in the UI
✓ [run 1/5] model requests from the browser were well-formed
✓ [run 1/5] no tool or gateway errors shown
✓ [run 1/5] dashboard draft card shown (not applied without a click)
✗ [run 1/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 232ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, ?@testid=data-testid Nav menu item×60, TruncatedText@testid=data-testid Nav menu item×60, Tooltip@aria=Undock menu×60, a@×60; augur components updated: Tooltip@testid=data-testid radio-button-option chat (augur)×60, Tooltip@testid=data-testid radio-button-option investigate (augur)×60, D@testid=input-wrapper (augur)×60, Tooltip@aria=History (augur)×60, Tooltip@aria=New conversation (augur)×60, Tooltip@aria=My preferences (augur)×60]
✓ [run 2/5] Augur app page renders with the composer
[run 2/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
        at bi (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27847)
        at Di (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27354)
        at _o (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60751)
        at fo (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60349)
        at onChange (http://localhost:3000/public/plugins/augur-assistant-app/592.js?_cache=da1fa96f7f1b0d07670e:1:48201)
        at Xh (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:130645)
        at <anonymous> (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:136006)
    loop probe: 60 commits in 761ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×54, Tooltip@aria=New conversation (augur)×54, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51, ?@aria=History (augur)×51, Tooltip@aria=History (augur)×51
✓ [run 2/5] scripted run finished in the UI
✓ [run 2/5] model requests from the browser were well-formed
✓ [run 2/5] no tool or gateway errors shown
✓ [run 2/5] dashboard draft card shown (not applied without a click)
✗ [run 2/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 761ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×54, Tooltip@aria=New conversation (augur)×54, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51, ?@aria=History (augur)×51, Tooltip@aria=History (augur)×51]
✓ [run 3/5] Augur app page renders with the composer
[run 3/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
        at bi (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27847)
        at Di (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27354)
        at _o (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60751)
        at fo (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60349)
        at onChange (http://localhost:3000/public/plugins/augur-assistant-app/592.js?_cache=da1fa96f7f1b0d07670e:1:48201)
        at Xh (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:130645)
        at <anonymous> (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:136006)
    loop probe: 60 commits in 748ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×57, Tooltip@aria=New conversation (augur)×57, Tooltip@aria=My preferences (augur)×55, Tooltip@aria=History (augur)×52, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51
✓ [run 3/5] scripted run finished in the UI
✓ [run 3/5] model requests from the browser were well-formed
✓ [run 3/5] no tool or gateway errors shown
✓ [run 3/5] dashboard draft card shown (not applied without a click)
✗ [run 3/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 748ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×57, Tooltip@aria=New conversation (augur)×57, Tooltip@aria=My preferences (augur)×55, Tooltip@aria=History (augur)×52, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51]
✓ [run 4/5] Augur app page renders with the composer
[run 4/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
        at bi (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27847)
        at Di (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27354)
        at _o (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60751)
        at fo (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60349)
        at onChange (http://localhost:3000/public/plugins/augur-assistant-app/592.js?_cache=da1fa96f7f1b0d07670e:1:48201)
        at Xh (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:130645)
        at <anonymous> (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:136006)
    loop probe: 60 commits in 751ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60; augur components updated: Tooltip@aria=New conversation (augur)×57, Tooltip@testid=data-testid radio-button-option investigate (augur)×56, Tooltip@aria=History (augur)×54, Tooltip@aria=My preferences (augur)×52, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51
✓ [run 4/5] scripted run finished in the UI
✓ [run 4/5] model requests from the browser were well-formed
✓ [run 4/5] no tool or gateway errors shown
✓ [run 4/5] dashboard draft card shown (not applied without a click)
✗ [run 4/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 751ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, Tooltip@aria=Close menu×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60; augur components updated: Tooltip@aria=New conversation (augur)×57, Tooltip@testid=data-testid radio-button-option investigate (augur)×56, Tooltip@aria=History (augur)×54, Tooltip@aria=My preferences (augur)×52, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51]
✓ [run 5/5] Augur app page renders with the composer
[run 5/5] page error:
    Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
        at bi (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27847)
        at Di (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:27354)
        at _o (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60751)
        at fo (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:60349)
        at onChange (http://localhost:3000/public/plugins/augur-assistant-app/592.js?_cache=da1fa96f7f1b0d07670e:1:48201)
        at Xh (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:130645)
        at <anonymous> (http://localhost:3000/public/build/7606.e8e4d98948a4bb1cf3bc.js:240:136006)
    loop probe: 60 commits in 749ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×57, Tooltip@aria=New conversation (augur)×57, Tooltip@aria=History (augur)×53, Tooltip@aria=My preferences (augur)×53, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51
✓ [run 5/5] scripted run finished in the UI
✓ [run 5/5] model requests from the browser were well-formed
✓ [run 5/5] no tool or gateway errors shown
✓ [run 5/5] dashboard draft card shown (not applied without a click)
✗ [run 5/5] no page errors: Error: Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings. [loop: 60 commits in 749ms, 0 scroll events; layout changes in window: 0; most updated: Tooltip@testid=data-testid Home breadcrumb×60, TruncatedText@testid=data-testid Nav menu item×60, ?@testid=data-testid Nav menu item×60, a@×60, Fo@×60, c@×60; augur components updated: Tooltip@testid=data-testid radio-button-option investigate (augur)×57, Tooltip@aria=New conversation (augur)×57, Tooltip@aria=History (augur)×53, Tooltip@aria=My preferences (augur)×53, Tooltip@testid=data-testid radio-button-option chat (augur)×51, D@testid=input-wrapper (augur)×51]

5 React update loop(s) (#185) during 5 Augur run(s).

5 UI check(s) failed
