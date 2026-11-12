# Development and testing

## Layout

```
augur-app/          # app plugin (React/TS): src/agent (agent, tools), src/session, src/components, src/headless
augur-datasource/   # datasource plugin (Go backend: model proxy + MCP client; config editor)
deploy/             # docker-compose demo with grafana/otel-lgtm
e2e/                # end-to-end tests: o11y-bench stack, stub model, headless and browser passes
bench/o11y-bench/   # run Augur on Grafana's o11y-bench
docs/               # this site (MkDocs Material)
```

## Build and test

Needs Node 22, Go and [mage](https://magefile.org/).

```bash
make install        # npm ci in both plugins
make lint           # eslint, tsc, go vet
make test           # jest + go test
make build          # frontend and Go backends
make package        # release zips
```

- **Unit and UI tests:** the agent and tools run against a fake Grafana API; `ChatPage.test.tsx` drives the whole UI with a scripted model. Go tests cover both auth modes, the guardrails, format translation and an MCP server over JSON and SSE.
- **Grafana 12 compatibility:** `scripts/check-grafana12.sh` type-checks both plugins against Grafana 12.0's packages.

## End-to-end tests

`make e2e` (and the E2E workflow on every push) runs a real Grafana 13 with Prometheus, Loki and Tempo preloaded with incident data (the o11y-bench stack), the plugins built from the commit, and a scripted stub model. No model key is needed. It checks:

- both plugins load and the datasource backend is healthy, and models are discovered
- the headless agent, twice (model directly and through the datasource), gets real query results, evidence ids, and saves a dashboard with panels and a Loki annotation
- in Chrome, five times: the app renders, a scripted run completes, the dashboard draft and its live preview render without errors, and no React update loops occur
- the menu placement

Results are published to the `ci-results` branch (`results/<sha>.md`).

## Benchmark

[o11y-bench](https://github.com/grafana/o11y-bench) is Grafana Labs' open benchmark for observability agents: 64 tasks across PromQL, LogQL, TraceQL, the Grafana API, dashboarding and investigations. `bench/o11y-bench` runs Augur on it with its own tools, and the benchmark's default agent with the same model for comparison:

```bash
export ANTHROPIC_API_KEY=...                       # also used by the grader's judge
export ANTHROPIC_BASE_URL=https://litellm.example  # optional: your gateway
bench/o11y-bench/run.sh anthropic/claude-sonnet-5-5 --task-name query-cpu-metrics --n-concurrent 1
bench/o11y-bench/run.sh anthropic/claude-sonnet-5-5   # full run
```

Needs Docker, [mise](https://mise.jdx.dev/) and [uv](https://docs.astral.sh/uv/). Add `--ak mode=investigate` for investigation mode. Reports land in `bench/.o11y-bench/jobs/*/run_report.html`.

## Releasing

- **One click:** *Actions → Release → Run workflow* with a version (`1.6.0`, or `1.6.0-rc.1`). It bumps both plugins, commits, tags and releases.
- **Or tag it:** `git tag v1.6.0 && git push origin v1.6.0`.

Each release runs lint, tests, the Grafana 12.0 check and the full build (Linux, macOS and Windows backends), optionally signs ([Plugin signing](../getting-started/signing.md)), runs Grafana's plugin validator, and publishes both zips, `SHA256SUMS` and build-provenance attestations. Add a `## <version>` section to both CHANGELOGs first.

## This site

```bash
pip install mkdocs-material
mkdocs serve        # http://127.0.0.1:8000
```

Pushes to `main` that touch `docs/` or `mkdocs.yml` publish it to GitHub Pages.

## Roadmap

Server-side runner for scheduled, alert-triggered and cross-device investigations; Slack; dashboard v2 schema editing; streaming responses.
