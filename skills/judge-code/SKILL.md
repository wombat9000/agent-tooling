---
name: judge-code
description: Lint production Kotlin or TypeScript files, module bundles, or directory structures against binary code-quality rubrics and optional repo conventions, inspect errors and warnings directly in source, and guide small behavior-preserving refactors. Use for rubric-based linting, architectural reviews, or before-and-after scoring.
---

# Judge production code

1. Pick the right scope:
   - **File linting (default):** `judge-code <path...>` or `judge-code --changed [base-ref]` runs all `file`-scoped checks across bundled rubrics using the fast model (`typesafe/jev-1.14`; add `--deep` for `liquid/d1.2-ultra`).
   - **Module architecture:** `judge-code module <path...>` evaluates whole module/feature directory bundle(s) against all `file` + `module` checks using `liquid/d1.2-ultra`.
   - **Directory layout:** `judge-code structure <path>` evaluates folder layout, concern separation, and integration hygiene from a compact structural manifest using `liquid/d1.2-ultra`.
2. When scanning a new repository or scope for the first time, preview with `--dry-run` (optionally `--out /path/to/new-private-dir` to inspect `request.json`) to verify the resolved files, rules, conventions, ignores, and credential checks, and confirm nothing unrelated or secret is included. For routine single-file or `--changed` lints in an already familiar repo, you can run directly.
3. Run live and inspect each `error` (raw model `FAIL`, `P(pass) < 0.50`) and `warning` (threshold borderline, raw `PASS` with `P(pass) < pass_threshold`) directly in the source files to verify whether it reflects a real issue before reporting or editing.
4. If authorized to edit, make small behavior-preserving refactors for verified findings, run the project's tests and checks, and re-run `judge-code` with the same scope, rubrics, exclusions, and model to compare results.

## Run the CLI

Use Node.js 22.18 or newer. Replace `$SKILL_DIR` with the installed skill directory.

```bash
# List bundled rubrics, check IDs, scopes, and non-default thresholds
node "$SKILL_DIR/scripts/judge-code.mts" list

# Default: fast per-file linter across 1+ files or directories (all file-scoped checks)
node "$SKILL_DIR/scripts/judge-code.mts" src/features/billing

# Lint only git-modified and untracked files (defaults to diffing against main, or HEAD fallback)
node "$SKILL_DIR/scripts/judge-code.mts" --changed
node "$SKILL_DIR/scripts/judge-code.mts" --changed origin/main --deep

# Architectural module scan (file + module checks, liquid/d1.2-ultra by default)
node "$SKILL_DIR/scripts/judge-code.mts" module src/features/billing

# Directory layout scan (structural manifest, liquid/d1.2-ultra by default)
node "$SKILL_DIR/scripts/judge-code.mts" structure src/features/billing

# Preview locally without API calls (and optionally save private request/result artifacts)
node "$SKILL_DIR/scripts/judge-code.mts" src/features/billing --dry-run
node "$SKILL_DIR/scripts/judge-code.mts" module src/features/billing --out /path/to/private-dir --dry-run
```

### Options

- `--deep` — switch OpenRouter model to `liquid/d1.2-ultra` (default for `module` and `structure`; default for file linting is `typesafe/jev-1.14`).
- `--model ID` — explicit OpenRouter Decisions model ID (openrouter backend only).
- `--quiet`, `-q` — print `error`s only and hide borderline `warning`s and warning-only files.
- `--json` — emit the full structured `JudgeResult` JSON to stdout instead of formatted linter output.
- `--out NEW_DIRECTORY` — optional private output directory (`0700` dir, `0600` files) for `request.json`, `response.txt` (redacting any echoed key), and `result.json` (plus `files/<slug>/` or `modules/<slug>/`). Must be outside any selected source directory. When omitted, nothing is written to disk.
- `--rubric NAME_OR_PATH` — narrow to specific bundled rubric slug(s)/version IDs (e.g. `readability`, `fowler-smells`, `module-design-v2`) or load a repo-local `.json` rubric (repeatable). Omitting `--rubric` runs all bundled rubrics for the active command.
- `--rule CHECK_ID` — narrow to specific check ID(s) (repeatable).
- `--exclude CHECK_ID` — exclude specific check ID(s) (repeatable).
- `--ignore GLOB` — exclude matching paths or basenames (repeatable). Patterns without `/` match basenames or directory segments (e.g. `--ignore '*-test-support.*'`, `--ignore '*.pb.ts'`); patterns with `/` match relative paths (e.g. `--ignore 'legacy/**'`).
- `--conventions FILE` / `--no-conventions` — repo-root `AGENTS.md` is auto-loaded when present (unless `--conventions` or `--no-conventions` is passed). Adds `state.conventions` with precedence over conflicting bundled criteria and includes the module/structure-scoped `follows_repo_conventions` check.
- `--requirements FILE` — optional Markdown or plain text requirements/spec document.
- `--changed [REF]` — lint only git-modified and untracked production files relative to `REF` (default `main`, falling back to `HEAD`). Optional positional paths narrow the changed-file set.
- `--max-warnings N` / `--fail-on-warning` — exit `1` if warning count exceeds `N` (`--fail-on-warning` is equivalent to `--max-warnings 0`).
- `--concurrency N` — max concurrent requests for file or multi-module scans (default `16` for OpenRouter, `4` for Codex/Claude).
- `--allow-credentials` — override the best-effort heuristic credential check after reviewing a false positive (never overrides an embedded `OPENROUTER_API_KEY`).
- `--dry-run` — validate inputs, rules, and payloads locally without sending requests.

### Output, severity, and exit codes

Default stdout prints an ESLint-style punch list showing only targets with findings (sorted worst-first by error count, warning count, then lowest `P(pass)`), a compact rule breakdown, and a final summary line:

```text
src/features/billing/workflow.ts
  error    no_long_functions            (0.22)
  warning  named_domain_expressions     (0.58 < 0.60)

Rules:
  no_long_functions            1 error
  named_domain_expressions     1 warning

✖ 1 error, 1 warning across 1 of 4 files (typesafe/jev-1.14, 4.1s)
```

- **`error`**: raw model `FAIL` (`model_choice === "fail"`, i.e. `P(pass) < 0.50`, or CLI backend `"fail"`).
- **`warning`**: threshold borderline (`model_choice === "pass"` with `P(pass) < pass_threshold`, or CLI backend `"borderline"`).
- **Exit `0`**: 0 errors (and warnings within `--max-warnings`, if set, and `--fail-on-warning` not triggered).
- **Exit `1`**: 1+ errors found (or `--fail-on-warning` / `--max-warnings` exceeded).
- **Exit `2`**: scoring, transport, backend, CLI argument, or input error (e.g. API HTTP error, errored file, invalid flags, or oversize input).

### Inputs, limits, and backends

Select regular `.kt`, `.ts`, `.tsx`, `.mts`, or `.cts` files or directories (or a directory for `structure`). Directory traversal skips symlinks, hidden entries (except React Router's `.server` and `.client` folders), build/generated/dependency directories (`node_modules`, `vendor`, `build`, `dist`, `out`, `target`, `coverage`, `generated`), and paths matched by `--ignore`. Universal cross-language test and test-support conventions (`test/`, `tests/`, `testing/`, `__tests__/`, `__mocks__/`, `__fixtures__/`, `testFixtures/`, `fixtures/`, `androidTest/`, `*.test.*`, `*.spec.*`, `*.mock.*`, `*_test.*`, `*_spec.*`, `*Test.*`, `*Tests.*`, `*Spec.*`, `conftest.py`, `test_*.py`) are excluded in file/module linting and classified as `test` in `structure`. A 128 KiB input limit applies (per file plus optional docs in file mode; combined per bundle in `module` and `structure` modes).

Live scoring defaults to [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) using `OPENROUTER_API_KEY` in the environment, with bounded exponential backoff retries on transient HTTP `429`/`502`/`503`/`504` responses. When `OPENROUTER_API_KEY` is unavailable, pass `--backend codex` (`gpt-6-luna` at `low` reasoning effort) or `--backend claude` (`haiku` with thinking disabled via `MAX_THINKING_TOKENS=0`) explicitly. Keep the same `--backend` across before-and-after runs so scores remain comparable.
