"""Run Amp locally inside Harbor's task container (Harbor 0.27+)."""

import shlex

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class AmpAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(skills=True, reasoning_effort=True)
    options_model = InstalledAgentOptions

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

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        api_key = self._get_env("AMP_EVAL_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Set AMP_EVAL_API_KEY to an Amp access token in the host environment. "
                "This adapter does not forward the orb's thread identity."
            )
        logs = shlex.quote(str(self.environment_logs_dir))
        command = [
            "amp", "--executor", "local", "--no-ide", "--stream-json",
            "--dangerously-allow-all",
        ]
        if self.model_name:
            command += ["--model", self.model_name]
        if self.options.reasoning_effort:
            command += ["--effort", self.options.reasoning_effort]
        command += ["-x", self.render_instruction(instruction)]
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {logs} && {shlex.join(command)} "
                f"> {logs}/amp.stdout.jsonl 2> {logs}/amp.stderr.log"
            ),
            env={"AMP_API_KEY": api_key},
        )
