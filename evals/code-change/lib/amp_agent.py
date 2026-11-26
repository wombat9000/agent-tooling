"""Run Amp locally inside Harbor's task container (Harbor 0.27+)."""

from __future__ import annotations

import shlex

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

JUDGE_CODE_INSTRUCTION_MARKER = "Optional self-check tool: judge-code"
JUDGE_CODE_EXTRA_INSTRUCTION = (
    "## Optional self-check tool: judge-code\n\n"
    "The `judge-code` skill is installed in your skills directory and "
    "`OPENROUTER_API_KEY` is configured in your environment.\n"
    "After implementing and verifying tests, run `judge-code` to lint your "
    'production code—both per-file (`node "$SKILL_DIR/scripts/judge-code.mts" '
    "<src-path>`) and module-level "
    '(`node "$SKILL_DIR/scripts/judge-code.mts" module <src-path>`)—inspect any '
    "reported errors or warnings in source, refactor to resolve real issues, "
    "and re-run tests and `judge-code` until clean while keeping tests green."
)


class AmpAgentOptions(InstalledAgentOptions):
    with_judge_code: bool = False


class AmpAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(skills=True, reasoning_effort=True)
    options_model = AmpAgentOptions
    options: AmpAgentOptions

    @staticmethod
    def name() -> str:
        return "amp"

    def get_version_command(self) -> str:
        return "amp --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if await self.is_requested_version_installed(environment):
            return
        package = "@sourcegraph/amp"
        if self._version:
            package += f"@{self._version}"
        await self.exec_as_root(
            environment, command=f"npm install -g {shlex.quote(package)}"
        )

    async def configure(self, environment: BaseEnvironment) -> None:
        if self.skills_dir:
            await self.exec_as_agent(
                environment,
                command=(
                    'mkdir -p "$HOME/.config/agents/skills" && '
                    f"cp -R {shlex.quote(self.skills_dir)}/. "
                    '"$HOME/.config/agents/skills/"'
                ),
            )

    def _resolve_runtime_env(self, amp_api_key: str) -> dict[str, str]:
        exec_env: dict[str, str] = {"AMP_API_KEY": amp_api_key}
        explicit_openrouter_key = (self._extra_env or {}).get("OPENROUTER_API_KEY", "").strip()
        if self.options.with_judge_code:
            openrouter_key = explicit_openrouter_key or (self._get_env("OPENROUTER_API_KEY") or "").strip()
            if not openrouter_key:
                raise RuntimeError(
                    "Set OPENROUTER_API_KEY in the host environment when running "
                    "AmpAgent with with_judge_code=true."
                )
            exec_env["OPENROUTER_API_KEY"] = openrouter_key
        elif explicit_openrouter_key:
            exec_env["OPENROUTER_API_KEY"] = explicit_openrouter_key
        return exec_env

    def _build_instruction(self, instruction: str) -> str:
        rendered = self.render_instruction(instruction)
        if self.options.with_judge_code and JUDGE_CODE_INSTRUCTION_MARKER not in rendered:
            return f"{rendered.rstrip()}\n\n{JUDGE_CODE_EXTRA_INSTRUCTION}"
        return rendered

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        api_key = self._get_env("AMP_EVAL_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Set AMP_EVAL_API_KEY to an Amp access token in the host environment. "
                "This adapter does not forward the orb's thread identity."
            )
        exec_env = self._resolve_runtime_env(api_key)
        logs = shlex.quote(str(self.environment_logs_dir))
        command = [
            "amp", "--executor", "local", "--no-ide", "--stream-json",
            "--dangerously-allow-all",
        ]
        if self.model_name:
            command += ["--model", self.model_name]
        if self.options.reasoning_effort:
            command += ["--effort", self.options.reasoning_effort]
        command += ["-x", self._build_instruction(instruction)]
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {logs} && {shlex.join(command)} "
                f"> {logs}/amp.stdout.jsonl 2> {logs}/amp.stderr.log"
            ),
            env=exec_env,
        )
