"""Offline unit tests for AmpAgent key isolation and --with-judge-code opt-in."""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

LIB_DIR = Path(__file__).resolve().parent
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))


def _ensure_harbor_importable() -> None:
    """Provide lightweight stubs when running under a plain system Python without Harbor."""
    try:
        import harbor.agents.installed.base  # noqa: F401
        return
    except ImportError:
        pass

    class AgentCapabilities:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    class InstalledAgentOptions:
        reasoning_effort: str | None = None
        version: str | None = None

        def __init__(self, **kwargs):
            for cls in reversed(type(self).__mro__):
                for key, value in cls.__dict__.items():
                    if not key.startswith("_") and not callable(value):
                        setattr(self, key, value)
            for key, value in kwargs.items():
                setattr(self, key, value)

    class BaseEnvironment:
        pass

    class AgentContext:
        def __init__(self) -> None:
            self.n_input_tokens: int | None = None
            self.n_cache_tokens: int | None = None
            self.n_output_tokens: int | None = None
            self.cost_usd: float | None = None

    class BaseInstalledAgent:
        options_model = InstalledAgentOptions

        def __init__(
            self,
            logs_dir: Path,
            model_name: str | None = None,
            skills_dir: str | None = None,
            extra_env: dict[str, str] | None = None,
            **kwargs,
        ):
            self.logs_dir = Path(logs_dir)
            self.environment_logs_dir = Path("/logs/agent")
            self.model_name = model_name
            self.skills_dir = skills_dir
            self._extra_env = dict(extra_env or {})
            self._version = kwargs.get("version")
            self.options = self.options_model(**kwargs)

        def _get_env(self, key: str) -> str | None:
            if key in self._extra_env:
                return self._extra_env[key]
            return os.environ.get(key)

        def render_instruction(self, instruction: str) -> str:
            return instruction

        async def exec_as_agent(self, environment, command: str, env: dict[str, str] | None = None):
            return await environment.exec(command=command, env=env)

        async def exec_as_root(self, environment, command: str, env: dict[str, str] | None = None):
            return await environment.exec(command=command, env=env, user="root")

    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.capabilities": types.ModuleType("harbor.agents.capabilities"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.base": types.ModuleType("harbor.agents.installed.base"),
        "harbor.agents.options": types.ModuleType("harbor.agents.options"),
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": types.ModuleType("harbor.environments.base"),
        "harbor.models": types.ModuleType("harbor.models"),
        "harbor.models.agent": types.ModuleType("harbor.models.agent"),
        "harbor.models.agent.context": types.ModuleType("harbor.models.agent.context"),
    }
    modules["harbor.agents.capabilities"].AgentCapabilities = AgentCapabilities
    modules["harbor.agents.installed.base"].BaseInstalledAgent = BaseInstalledAgent
    modules["harbor.agents.options"].InstalledAgentOptions = InstalledAgentOptions
    modules["harbor.environments.base"].BaseEnvironment = BaseEnvironment
    modules["harbor.models.agent.context"].AgentContext = AgentContext

    for name, mod in modules.items():
        sys.modules[name] = mod


_ensure_harbor_importable()
amp_agent = importlib.import_module("amp_agent")
from harbor.models.agent.context import AgentContext  # noqa: E402


class FakeEnvironment:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def exec(self, command: str, env: dict[str, str] | None = None, **kwargs):
        self.calls.append({"command": command, "env": dict(env or {}), "kwargs": kwargs})
        return types.SimpleNamespace(return_code=0, stdout="", stderr="")


class AmpAgentTests(unittest.TestCase):
    def _make_agent(self, **kwargs):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        return amp_agent.AmpAgent(logs_dir=Path(self._tmp.name), **kwargs)

    def test_default_run_does_not_leak_host_openrouter_key(self) -> None:
        agent = self._make_agent(model_name="openai/gpt-6.1-terra")
        env = FakeEnvironment()
        with mock.patch.dict(
            os.environ,
            {"AMP_EVAL_API_KEY": "amp-secret", "OPENROUTER_API_KEY": "host-only-secret"},
            clear=False,
        ):
            asyncio.run(agent.run("Do the task.", env, AgentContext()))

        self.assertEqual(len(env.calls), 1)
        self.assertEqual(env.calls[0]["env"], {"AMP_API_KEY": "amp-secret"})
        self.assertNotIn("OPENROUTER_API_KEY", env.calls[0]["env"])
        self.assertNotIn("judge-code", env.calls[0]["command"])

    def test_with_judge_code_forwards_openrouter_key_and_appends_instruction(self) -> None:
        agent = self._make_agent(model_name="openai/gpt-6.1-terra", with_judge_code=True)
        env = FakeEnvironment()
        with mock.patch.dict(
            os.environ,
            {"AMP_EVAL_API_KEY": "amp-secret", "OPENROUTER_API_KEY": "or-secret"},
            clear=False,
        ):
            asyncio.run(agent.run("Refactor module.", env, AgentContext()))

        self.assertEqual(
            env.calls[0]["env"],
            {"AMP_API_KEY": "amp-secret", "OPENROUTER_API_KEY": "or-secret"},
        )
        self.assertIn("Required quality gate: judge-code", env.calls[0]["command"])
        self.assertIn('judge-code.mts" <src-path>`', env.calls[0]["command"])
        self.assertNotIn('judge-code.mts" <src-path> --fail-on-warning', env.calls[0]["command"])
        self.assertIn("module <src-path> --fail-on-warning", env.calls[0]["command"])
        self.assertIn("must exit 0 (0 errors)", env.calls[0]["command"])
        self.assertIn("must exit 0 (0 errors and 0 warnings)", env.calls[0]["command"])
        self.assertIn("up to 3 fix-and-recheck passes", env.calls[0]["command"])
        self.assertNotIn("Optional self-check", env.calls[0]["command"])

    def test_with_judge_code_does_not_duplicate_existing_instruction_note(self) -> None:
        agent = self._make_agent(with_judge_code=True)
        env = FakeEnvironment()
        instruction = f"Refactor module.\n\n{amp_agent.JUDGE_CODE_EXTRA_INSTRUCTION}"
        with mock.patch.dict(
            os.environ,
            {"AMP_EVAL_API_KEY": "amp-secret", "OPENROUTER_API_KEY": "or-secret"},
            clear=False,
        ):
            asyncio.run(agent.run(instruction, env, AgentContext()))

        self.assertEqual(
            env.calls[0]["command"].count(amp_agent.JUDGE_CODE_INSTRUCTION_MARKER),
            1,
        )

    def test_with_judge_code_fails_fast_when_openrouter_key_missing(self) -> None:
        agent = self._make_agent(with_judge_code=True)
        env = FakeEnvironment()
        cleaned = {k: v for k, v in os.environ.items() if k != "OPENROUTER_API_KEY"}
        cleaned["AMP_EVAL_API_KEY"] = "amp-secret"
        with mock.patch.dict(os.environ, cleaned, clear=True):
            with self.assertRaisesRegex(RuntimeError, "OPENROUTER_API_KEY"):
                asyncio.run(agent.run("Refactor module.", env, AgentContext()))
        self.assertEqual(len(env.calls), 0)

    def test_explicit_extra_env_forwards_openrouter_key_for_harbor_ae_flag(self) -> None:
        agent = self._make_agent(extra_env={"OPENROUTER_API_KEY": "from-ae-flag"})
        env = FakeEnvironment()
        with mock.patch.dict(os.environ, {"AMP_EVAL_API_KEY": "amp-secret"}, clear=False):
            asyncio.run(agent.run("Refactor module.", env, AgentContext()))

        self.assertEqual(
            env.calls[0]["env"],
            {"AMP_API_KEY": "amp-secret", "OPENROUTER_API_KEY": "from-ae-flag"},
        )

    def test_configure_copies_all_mounted_skills_into_amp_skills_dir(self) -> None:
        agent = self._make_agent(skills_dir="/skills")
        env = FakeEnvironment()
        asyncio.run(agent.configure(env))
        self.assertEqual(len(env.calls), 1)
        self.assertIn("cp -R /skills/.", env.calls[0]["command"])
        self.assertIn("$HOME/.config/agents/skills/", env.calls[0]["command"])

    def test_populate_context_parses_result_event_usage_and_cost(self) -> None:
        agent = self._make_agent()
        stream = agent.logs_dir / "amp.stdout.jsonl"
        stream.write_text(
            "\n".join(
                [
                    '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":20}}}',
                    '{"type":"result","total_cost_usd":0.145,"usage":{"input_tokens":1200,"cache_read_input_tokens":800,"cache_creation_input_tokens":200,"output_tokens":450}}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        ctx = AgentContext()
        agent.populate_context_post_run(ctx)
        self.assertEqual(ctx.n_input_tokens, 2200)
        self.assertEqual(ctx.n_cache_tokens, 1000)
        self.assertEqual(ctx.n_output_tokens, 450)
        self.assertAlmostEqual(ctx.cost_usd or 0.0, 0.145, places=6)

    def test_populate_context_sums_deduplicated_turn_events_when_no_result_event(self) -> None:
        agent = self._make_agent()
        stream = agent.logs_dir / "amp.stdout.jsonl"
        stream.write_text(
            "\n".join(
                [
                    "not json at all",
                    '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":300,"cache_read_input_tokens":100,"output_tokens":40}}}',
                    '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":300,"cache_read_input_tokens":100,"output_tokens":60}}}',
                    '{"type":"assistant","message":{"id":"m2","usage":{"prompt_tokens":500,"prompt_tokens_details":{"cached_tokens":200},"completion_tokens":80}},"cost_usd":0.03}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        ctx = AgentContext()
        agent.populate_context_post_run(ctx)
        self.assertEqual(ctx.n_input_tokens, 900)
        self.assertEqual(ctx.n_cache_tokens, 300)
        self.assertEqual(ctx.n_output_tokens, 140)
        self.assertAlmostEqual(ctx.cost_usd or 0.0, 0.03, places=6)

    def test_populate_context_parses_model_usage_map_and_handles_missing_or_corrupt_streams(self) -> None:
        agent = self._make_agent()
        # Missing stream file never crashes and leaves fields None.
        missing_ctx = AgentContext()
        agent.populate_context_post_run(missing_ctx)
        self.assertIsNone(missing_ctx.n_input_tokens)
        self.assertIsNone(missing_ctx.n_cache_tokens)
        self.assertIsNone(missing_ctx.n_output_tokens)
        self.assertIsNone(missing_ctx.cost_usd)

        # modelUsage breakdown sums across models.
        stream = agent.logs_dir / "amp.stdout.jsonl"
        stream.write_text(
            '{"type":"result","modelUsage":{"mA":{"inputTokens":400,"cacheReadInputTokens":100,"outputTokens":50,"costUSD":0.02},"mB":{"inputTokens":600,"outputTokens":75,"costUSD":0.03}}}\n',
            encoding="utf-8",
        )
        ctx = AgentContext()
        agent.populate_context_post_run(ctx)
        self.assertEqual(ctx.n_input_tokens, 1100)
        self.assertEqual(ctx.n_cache_tokens, 100)
        self.assertEqual(ctx.n_output_tokens, 125)
        self.assertAlmostEqual(ctx.cost_usd or 0.0, 0.05, places=6)

        # Malformed/non-numeric usage values never raise.
        stream.write_text('{"type":"result","usage":{"input_tokens":"oops","output_tokens":-5},"total_cost_usd":null}\n', encoding="utf-8")
        bad_ctx = AgentContext()
        agent.populate_context_post_run(bad_ctx)
        self.assertIsNone(bad_ctx.n_input_tokens)
        self.assertIsNone(bad_ctx.n_output_tokens)
        self.assertIsNone(bad_ctx.cost_usd)


if __name__ == "__main__":
    unittest.main()
