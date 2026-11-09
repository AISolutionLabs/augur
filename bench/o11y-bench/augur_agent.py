"""Augur as a Harbor agent for o11y-bench (https://github.com/grafana/o11y-bench).

Runs the Augur headless runner (the same agent, tools and prompts as the Grafana app) inside the
task container against the benchmark's Grafana. Augur uses its own Grafana tools, not mcp-grafana.

Install: copy this file into o11y-bench/agents/ and the bundle built by `npm run build:headless`
(augur-app/dist-headless/augur-headless.mjs) next to it, or use bench/o11y-bench/run.sh.

Model access (pick one):
  ANTHROPIC_API_KEY [+ ANTHROPIC_BASE_URL]      Anthropic Messages API
  AUGUR_MODEL_BASE_URL + AUGUR_MODEL_API_KEY    any Messages-compatible gateway, e.g. LiteLLM
                                                (its /v1/messages endpoint); bearer auth
Agent kwargs (--ak): mode=chat|investigate (default chat), subagents=true|false (default true).

Proposals are applied automatically in this harness (AUGUR_APPLY=auto): there is no user to click
Apply, and dashboard tasks are graded on what is saved in Grafana.
"""

import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HERE = Path(__file__).parent
BUNDLE = Path(os.environ.get("AUGUR_HEADLESS_BUNDLE", HERE / "augur-headless.mjs"))
NODE_VERSION = os.environ.get("AUGUR_NODE_VERSION", "22.12.0")
STDOUT = "/logs/agent/command-0/stdout.txt"

# Installs Node in the task container if it has none (the o11y-bench image is Python-only).
ENSURE_NODE = f"""
set -e
if ! command -v node >/dev/null 2>&1; then
  case "$(uname -m)" in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) echo "unsupported arch $(uname -m)"; exit 1;; esac
  curl -fsSL "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-$a.tar.xz" -o /tmp/node.tar.xz
  mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
fi
node --version
"""

TASK_PROMPT = "<context>\nCurrent time: {current_time}\n</context>\n\n{statement}"


def strip_provider(model: str) -> str:
    return model.split("/", 1)[1] if model.startswith(("anthropic/", "litellm/")) else model


class AugurAgent(BaseAgent):
    capabilities = AgentCapabilities(mcp_servers=True)  # tasks declare mcp-grafana; Augur doesn't need it

    def __init__(self, logs_dir: Path, model_name: str | None = None, mode: str = "chat", subagents: Any = True, **kwargs: Any):
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        if mode not in ("chat", "investigate"):
            raise ValueError("mode must be chat or investigate")
        self.mode = mode
        self.subagents = str(subagents).lower() not in ("0", "false", "no")

    @staticmethod
    def name() -> str:
        return "augur"

    def version(self) -> str:
        return os.environ.get("AUGUR_VERSION", "dev")

    async def setup(self, environment: BaseEnvironment) -> None:
        if not BUNDLE.is_file():
            raise FileNotFoundError(f"{BUNDLE} missing: run `npm run build:headless` in augur-app and copy dist-headless/augur-headless.mjs here")
        await environment.upload_file(source_path=BUNDLE, target_path="/app/augur-headless.mjs")
        result = await environment.exec(command=f"bash -lc {shlex.quote(ENSURE_NODE)}")
        if result.return_code != 0:
            raise RuntimeError(f"could not install Node in the task container: {result.stdout} {result.stderr}")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model = strip_provider(self.model_name or "anthropic/claude-sonnet-4-6")
        now = os.environ.get("O11Y_SCENARIO_TIME_ISO", "")
        prompt_path = self.logs_dir / "prompt.txt"
        prompt_path.write_text(TASK_PROMPT.format(current_time=now or "(now)", statement=instruction))
        await environment.upload_file(source_path=prompt_path, target_path="/app/prompt.txt")

        env: dict[str, str] = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "MODEL": model,
            "AUGUR_MODE": self.mode,
            "AUGUR_SUBAGENTS": "1" if self.subagents else "0",
            "AUGUR_APPLY": "auto",
            "AUGUR_PROMPT_FILE": "/app/prompt.txt",
            "AUGUR_TRAJECTORY": "/logs/agent/trajectory.json",
            "AUGUR_VERSION": self.version(),
        }
        if now:
            env["AUGUR_NOW"] = now
        if os.environ.get("AUGUR_MODEL_BASE_URL"):
            env["MODEL_BASE_URL"] = os.environ["AUGUR_MODEL_BASE_URL"]
            env["MODEL_API_KEY"] = os.environ.get("AUGUR_MODEL_API_KEY", "")
            env["MODEL_AUTH_HEADER"] = os.environ.get("AUGUR_MODEL_AUTH_HEADER", "authorization")
        else:
            env["MODEL_BASE_URL"] = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
            env["MODEL_API_KEY"] = os.environ.get("ANTHROPIC_API_KEY", "")
        if not env["MODEL_API_KEY"]:
            raise RuntimeError("set ANTHROPIC_API_KEY, or AUGUR_MODEL_BASE_URL and AUGUR_MODEL_API_KEY")
        for key in ("AUGUR_MAX_STEPS", "AUGUR_MAX_TOKENS", "AUGUR_MAX_TOKENS_PER_RUN"):
            if os.environ.get(key):
                env[key] = os.environ[key]

        # GRAFANA_URL is set on the task container by the o11y-bench compose overlay (anonymous admin).
        cmd = f'set -o pipefail; mkdir -p /logs/agent/command-0; GRAFANA_URL="${{GRAFANA_URL:-http://$STACK_HOST:3000}}" node /app/augur-headless.mjs 2>&1 | tee "{STDOUT}"'
        self.logger.info(f"Running Augur ({self.mode}) with model={model}")
        result = await environment.exec(command=f"bash -lc {shlex.quote(cmd)}", env=env)

        try:
            await environment.download_file(source_path="/logs/agent/trajectory.json", target_path=self.logs_dir / "trajectory.json")
            fm = json.loads((self.logs_dir / "trajectory.json").read_text()).get("final_metrics") or {}
            context.n_input_tokens = fm.get("total_prompt_tokens")
            context.n_output_tokens = fm.get("total_completion_tokens")
            context.n_cache_tokens = fm.get("total_cached_tokens")
        except Exception as e:  # noqa: BLE001 - metrics are best effort
            self.logger.warning(f"Could not read trajectory metrics: {e}")
        context.metadata = {**(context.metadata or {}), "model": model, "agent": "augur", "mode": self.mode}
        if result.return_code != 0:
            raise NonZeroAgentExitCodeError(f"Augur exited with code {result.return_code}")
