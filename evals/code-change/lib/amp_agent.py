"""Run Amp locally inside Harbor's task container (Harbor 0.27+)."""

from __future__ import annotations

import json
import math
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

JUDGE_CODE_INSTRUCTION_MARKER = "Required quality gate: judge-code"
JUDGE_CODE_EXTRA_INSTRUCTION = (
    "## Required quality gate: judge-code\n\n"
    "The `judge-code` skill is installed in your skills directory and "
    "`OPENROUTER_API_KEY` is configured in your environment.\n"
    "Before finishing, your production code **must** pass both checks while keeping typecheck and tests green:\n"
    '- Per-file check (fast `jev-1.14`): `node "$SKILL_DIR/scripts/judge-code.mts" <src-path>` — **must exit 0 (0 errors)**; address genuine warnings where helpful.\n'
    '- Module check (`d1.2-ultra`): `node "$SKILL_DIR/scripts/judge-code.mts" module <src-path> --fail-on-warning` — **must exit 0 (0 errors and 0 warnings)**.\n'
    "Refactor your production code and re-run typecheck, tests, and both `judge-code` commands for up to 3 fix-and-recheck passes until both exit 0."
)


def _non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return int(round(value))


def _non_negative_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return float(value)


def _first_int(mapping: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        parsed = _non_negative_int(mapping.get(key))
        if parsed is not None:
            return parsed
    return None


def _first_float(mapping: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        parsed = _non_negative_float(mapping.get(key))
        if parsed is not None:
            return parsed
    return None


def _extract_usage_block(usage: dict[str, Any]) -> dict[str, int | float | None]:
    """Extract normalized token/cost metrics from a single usage dict.

    Follows Harbor AgentContext semantics: ``n_input_tokens`` is total input
    tokens including cache. Anthropic/Amp ``input_tokens`` excludes cache read
    and cache creation tokens, while OpenAI ``prompt_tokens`` already includes
    cached tokens.
    """
    cache_read = _first_int(
        usage,
        (
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cached_input_tokens",
            "cached_tokens",
            "cache_tokens",
        ),
    )
    if cache_read is None and isinstance(usage.get("prompt_tokens_details"), dict):
        cache_read = _first_int(
            usage["prompt_tokens_details"],
            ("cached_tokens", "cache_read_input_tokens"),
        )
    if cache_read is None and isinstance(usage.get("input_tokens_details"), dict):
        cache_read = _first_int(
            usage["input_tokens_details"],
            ("cached_tokens", "cache_read_input_tokens"),
        )

    cache_creation = _first_int(
        usage,
        ("cache_creation_input_tokens", "cacheCreationInputTokens"),
    )

    anthropic_input = _first_int(usage, ("input_tokens", "inputTokens"))
    openai_prompt = _first_int(usage, ("prompt_tokens", "promptTokens"))

    n_input: int | None = None
    if anthropic_input is not None:
        n_input = anthropic_input + (cache_read or 0) + (cache_creation or 0)
    elif openai_prompt is not None:
        n_input = openai_prompt
    elif cache_read is not None or cache_creation is not None:
        n_input = (cache_read or 0) + (cache_creation or 0)

    n_cache: int | None = None
    if cache_read is not None or cache_creation is not None:
        n_cache = (cache_read or 0) + (cache_creation or 0)

    n_output = _first_int(
        usage,
        ("output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
    )
    cost_usd = _first_float(
        usage,
        ("total_cost_usd", "cost_usd", "costUSD", "totalCostUsd", "cost"),
    )

    return {
        "n_input_tokens": n_input,
        "n_cache_tokens": n_cache,
        "n_output_tokens": n_output,
        "cost_usd": cost_usd,
    }


def _extract_model_usage_totals(model_usage: dict[str, Any]) -> dict[str, int | float | None]:
    totals: dict[str, int | float | None] = {
        "n_input_tokens": None,
        "n_cache_tokens": None,
        "n_output_tokens": None,
        "cost_usd": None,
    }
    for entry in model_usage.values():
        if not isinstance(entry, dict):
            continue
        parsed = _extract_usage_block(entry)
        for key in totals:
            val = parsed[key]
            if val is not None:
                totals[key] = (totals[key] or 0) + val
    return totals


def parse_amp_stream_usage(stream_path: Path) -> dict[str, int | float | None]:
    """Defensively parse token and cost totals from Amp's --stream-json JSONL output."""
    empty: dict[str, int | float | None] = {
        "n_input_tokens": None,
        "n_cache_tokens": None,
        "n_output_tokens": None,
        "cost_usd": None,
    }
    if not stream_path.is_file():
        return empty

    result_tokens: dict[str, int | float | None] | None = None
    result_cost: float | None = None

    turn_usage_by_id: dict[str, dict[str, int | float | None]] = {}
    anonymous_turns: list[dict[str, int | float | None]] = []

    try:
        raw_text = stream_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return empty

    for line in raw_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            event = json.loads(stripped)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue

        event_type = event.get("type")
        event_cost = _first_float(
            event,
            ("total_cost_usd", "cost_usd", "costUSD", "totalCostUsd", "cost"),
        )

        if event_type == "result":
            model_usage = event.get("modelUsage") or event.get("model_usage")
            usage_dict = event.get("usage")
            parsed: dict[str, int | float | None] | None = None
            if isinstance(model_usage, dict) and model_usage:
                parsed = _extract_model_usage_totals(model_usage)
            if isinstance(usage_dict, dict):
                from_usage = _extract_usage_block(usage_dict)
                if parsed is None:
                    parsed = from_usage
                else:
                    for key in empty:
                        if parsed[key] is None and from_usage[key] is not None:
                            parsed[key] = from_usage[key]
            if parsed is not None and any(parsed[k] is not None for k in ("n_input_tokens", "n_cache_tokens", "n_output_tokens")):
                result_tokens = parsed
            if event_cost is not None:
                result_cost = event_cost
            elif parsed is not None and parsed["cost_usd"] is not None:
                result_cost = float(parsed["cost_usd"])
            continue

        usage_obj: dict[str, Any] | None = None
        message_id: str | None = None
        message = event.get("message")
        if isinstance(message, dict):
            if isinstance(message.get("id"), str) and message["id"]:
                message_id = message["id"]
            if isinstance(message.get("usage"), dict):
                usage_obj = message["usage"]
        if usage_obj is None and isinstance(event.get("usage"), dict):
            usage_obj = event["usage"]
            if isinstance(event.get("id"), str) and event["id"]:
                message_id = event["id"]

        if usage_obj is None and event_cost is None:
            continue

        parsed_turn = _extract_usage_block(usage_obj) if usage_obj is not None else dict(empty)
        if parsed_turn["cost_usd"] is None and event_cost is not None:
            parsed_turn["cost_usd"] = event_cost

        if any(value is not None for value in parsed_turn.values()):
            if message_id is not None:
                turn_usage_by_id[message_id] = parsed_turn
            else:
                anonymous_turns.append(parsed_turn)

    if result_tokens is not None:
        out = dict(result_tokens)
        if result_cost is not None:
            out["cost_usd"] = result_cost
        return out

    totals = dict(empty)
    for turn in [*turn_usage_by_id.values(), *anonymous_turns]:
        for key in totals:
            val = turn[key]
            if val is not None:
                totals[key] = (totals[key] or 0) + val

    if result_cost is not None:
        totals["cost_usd"] = result_cost

    return {
        "n_input_tokens": int(totals["n_input_tokens"]) if totals["n_input_tokens"] is not None else None,
        "n_cache_tokens": int(totals["n_cache_tokens"]) if totals["n_cache_tokens"] is not None else None,
        "n_output_tokens": int(totals["n_output_tokens"]) if totals["n_output_tokens"] is not None else None,
        "cost_usd": float(totals["cost_usd"]) if totals["cost_usd"] is not None else None,
    }


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

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse token usage and cost from amp.stdout.jsonl without ever crashing a trial."""
        try:
            usage = parse_amp_stream_usage(self.logs_dir / "amp.stdout.jsonl")
            if usage["n_input_tokens"] is not None:
                context.n_input_tokens = int(usage["n_input_tokens"])
            if usage["n_cache_tokens"] is not None:
                context.n_cache_tokens = int(usage["n_cache_tokens"])
            if usage["n_output_tokens"] is not None:
                context.n_output_tokens = int(usage["n_output_tokens"])
            if usage["cost_usd"] is not None:
                context.cost_usd = float(usage["cost_usd"])
        except Exception:
            return

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
