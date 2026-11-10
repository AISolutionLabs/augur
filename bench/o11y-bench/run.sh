#!/usr/bin/env bash
# Runs Augur on o11y-bench (https://github.com/grafana/o11y-bench) and, for comparison, the
# benchmark's default agent with the same model. Needs Docker, mise, uv, Node 20+.
#
#   export ANTHROPIC_API_KEY=...                  # model + the benchmark's grader (Claude judge)
#   export ANTHROPIC_BASE_URL=https://litellm...  # optional: a gateway exposing /v1/messages
#   bench/o11y-bench/run.sh anthropic/claude-sonnet-5-5 [extra o11y-bench job args]
#
# Examples of extra args: --task-name query-cpu-metrics --n-concurrent 1   (one task, smoke test)
#                         --ak mode=investigate                            (investigation mode)
# Set BASELINE=0 to skip the default-agent run.
set -euo pipefail
MODEL=${1:?usage: run.sh <provider/model> [o11y-bench job args]}
shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF=${O11Y_BENCH_REF:-$(cat "$ROOT/e2e/o11y-bench.ref")}
DIR=${O11Y_BENCH_DIR:-$ROOT/bench/.o11y-bench}

[ -d "$DIR/.git" ] || git clone -q https://github.com/grafana/o11y-bench "$DIR"
git -C "$DIR" fetch -q --depth 1 origin "$REF" 2>/dev/null || true
git -C "$DIR" checkout -q "$REF"

(cd "$ROOT/augur-app" && { [ -d node_modules ] || npm ci; } && npm run -s build:headless)
cp "$ROOT/bench/o11y-bench/augur_agent.py" "$ROOT/augur-app/dist-headless/augur-headless.mjs" "$DIR/agents/"
export AUGUR_VERSION
AUGUR_VERSION=$(node -p "require('$ROOT/augur-app/package.json').version")

cd "$DIR"
mise install -q
uv sync -q
echo "== Augur $AUGUR_VERSION with $MODEL"
mise run bench:job -- --model "$MODEL" --agent-import-path agents.augur_agent:AugurAgent "$@"
if [ "${BASELINE:-1}" = 1 ]; then
  echo "== o11y-bench default agent (mcp-grafana) with $MODEL"
  mise run bench:job -- --model "$MODEL" "$@"
fi
echo "Reports: $DIR/jobs/*/run_report.html"
