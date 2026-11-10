#!/usr/bin/env bash
# End-to-end test: real Grafana 13 + Prometheus/Loki/Tempo (o11y-bench stack with seeded incident
# data) + the Augur plugins + a scripted stub model. Needs Docker, Node 20+, and Chrome for the UI
# check (CHROME_PATH; skip with E2E_UI=0). Run `make build` first.
set -euo pipefail
cd "$(dirname "$0")"
O11Y_BENCH_REF=${O11Y_BENCH_REF:-b66d8cfbbe309d2e03e9a301baea056d9718b71b}
export O11Y_BENCH_DIR=${O11Y_BENCH_DIR:-$PWD/.o11y-bench}
if [ ! -d "$O11Y_BENCH_DIR/.git" ]; then
  git clone -q https://github.com/grafana/o11y-bench "$O11Y_BENCH_DIR"
fi
git -C "$O11Y_BENCH_DIR" fetch -q --depth 1 origin "$O11Y_BENCH_REF" 2>/dev/null || true
git -C "$O11Y_BENCH_DIR" checkout -q "$O11Y_BENCH_REF"
export O11Y_SCENARIO_TIME_ISO=${O11Y_SCENARIO_TIME_ISO:-$(date -u +%Y-%m-%dT%H:%M:00Z)}

for d in ../augur-app/dist ../augur-datasource/dist ../augur-app/dist-headless/augur-headless.mjs; do
  [ -e "$d" ] || { echo "missing $d: run make build (and npm run build:headless in augur-app)"; exit 1; }
done
[ -d node_modules ] || npm ci --ignore-scripts

cleanup() { [ "${E2E_KEEP:-0}" = 1 ] || docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
diagnose() {
  echo "---- stack container (last 80 lines)"; docker compose logs --tail 80 stack || true
  for f in artifacts/sidecar/*.log; do [ -f "$f" ] && { echo "---- $f (errors)"; grep -iE 'error|fail|panic|augur' "$f" | tail -40; }; done
}
rm -rf artifacts && mkdir -p artifacts
docker compose up -d --build --wait || { diagnose; exit 1; }
echo "stack ready (scenario clock $O11Y_SCENARIO_TIME_ISO)"

export GRAFANA_URL=http://localhost:3000
curl -sf "$GRAFANA_URL/api/plugins/augur-assistant-app/settings" | grep -q '"enabled":true' && echo "✓ Augur app enabled" || { echo "✗ Augur app not loaded"; docker compose logs stack | tail -50; exit 1; }
curl -sf "$GRAFANA_URL/api/datasources/uid/augur-e2e/health" | grep -q '"status":"OK"' && echo "✓ Augur datasource backend healthy" || { echo "✗ Augur datasource health check failed"; curl -s "$GRAFANA_URL/api/datasources/uid/augur-e2e/health"; exit 1; }

echo; echo "== headless, model called directly"
STUB_URL=http://127.0.0.1:8787 node smoke.mjs
echo; echo "== headless, model through the Augur datasource backend"
AUGUR_DATASOURCE_UID=augur-e2e node smoke.mjs
if [ "${E2E_UI:-1}" = 1 ]; then
  echo; echo "== UI in Chrome"
  SCREENSHOT=${SCREENSHOT:-$PWD/e2e-ui.png} node ui.mjs
fi
