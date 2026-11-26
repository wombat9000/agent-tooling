---
name: judge-code
description: Score a production Kotlin or TypeScript module against binary code-quality rubrics and optional repo conventions, inspect failed checks directly in source, and guide small behavior-preserving refactors. Use for rubric-based quality assessment or before-and-after scoring.
---

# Judge production code

1. Select the smallest production module that still shows the relevant relationships, along with any applicable rubrics (`--rubric`, `--all`, or a local `.json` rubric), optional `--requirements` or `--conventions` documents, and `--exclude` for checks that conflict with the repository's framework or conventions.
2. Run the bundled CLI with `--dry-run`. Inspect `request.json` for the complete numbered files, optional documents, and resolved criteria. Narrow the selection if anything is unrelated or contains secrets.
3. Run with the same inputs, a fresh output directory, and `--dry-run` removed. Read `result.json` for pass/fail choices (checks default to `P(pass) >= 0.80` to pass unless a rubric question defines a per-criterion `pass_threshold`; raw `model_choice`, `pass_probability`, and `confidence` are also preserved), and check `request.json` for the exact criteria of any failed checks. Inspect the current source directly to verify whether each failed check reflects a real issue before reporting it or making a change.
4. If authorized to edit, use verified failures to make small behavior-preserving refactors. Run the project's tests and checks, then re-score with the same rubrics, exclusions, model, and source scope to compare results.

## Run the CLI

Use Node.js 22.18 or newer. Replace `$SKILL_DIR` with the installed skill directory.

```bash
node "$SKILL_DIR/scripts/judge-code.mts" --list-rubrics
node "$SKILL_DIR/scripts/judge-code.mts" \
  --source src/main/kotlin/booking \
  --rubric module-design --rubric readability \
  --out /path/to/new-private-directory --dry-run
```

Optional real-repo flags:
- `--mode file` — per-file linter scan across a directory or repository (even when total size exceeds 128 KiB). Filters selected rubrics to `file`-scoped checks (cross-file checks such as `single_responsibility`, `dependency_inversion`, `boundary_separation`, and `follows_repo_conventions` are `module`-scoped and recorded in `skipped_module_checks`, while `--conventions` still injects `state.conventions` precedence), applies the 128 KiB limit per individual file plus optional documents, scores files concurrently (`--concurrency`, defaulting to 16 for OpenRouter and 4 for Codex/Claude), and writes aggregated `result.json` plus per-file artifacts under `files/<slug>/`.
- `--mode structure` (or `--rubric project-structure` / `--rubric integration-readiness-structure`) — score a directory's folder layout, sub-feature grouping, concern separation, and integration hygiene using a compact structural manifest (directory counts, file line counts, exports, and imports) instead of sending full file bodies. Omitting `--rubric` in structure mode runs all bundled structure rubrics.
- `--all` — include all bundled rubrics for the active mode (combine with `--exclude <check_id>` to drop checks that do not fit the codebase).
- `--ignore GLOB` — exclude matching paths or basenames from scoring (repeatable; distinct from `--exclude <check_id>`, which excludes rubric checks). Patterns without `/` match basenames or directory segments (e.g., `--ignore '*-test-support.*'`, `--ignore '*.pb.ts'`); patterns with `/` match paths relative to `--source` (e.g., `--ignore 'legacy/**'`, `--ignore '**/generated/**'`). Applies across `code`, `file`, and `structure` modes.
- `--rubric path/to/custom.json` — load a repo-local binary rubric using the same `{ rubric, questions }` JSON schema (set `"target": "project_structure"` for structure-mode rubrics; `production_code` questions may include optional `"scope": "file" | "module"`, defaulting to `"module"` when omitted; any question may include an optional `"pass_threshold"` as a finite number in `(0, 1]`, defaulting to `0.80` on OpenRouter, stripped from `request.json`, ignored by CLI backends, and recorded in `result.json` under `check_thresholds` and on affected checks when overridden). Bundled rubrics accept short names (`module-design`, `api-design`, `integration-readiness`, `project-structure`, `integration-readiness-structure`) or pinned version IDs (`module-design-v2`, `api-design-v3`, `integration-readiness-v3`). Run `--list-rubrics` to inspect every bundled rubric, its check IDs, and each check's scope (`file`, `module`, or `structure`) and any non-default pass threshold.
- `--requirements FILE` — optional Markdown or plain text requirements/spec document.
- `--conventions FILE` — optional Markdown or plain text coding conventions document. Adds `state.conventions` with precedence over conflicting bundled criteria and includes a `follows_repo_conventions` check (which can be suppressed with `--exclude follows_repo_conventions` if you only want precedence).
- `--format summary` — print a linter-style punch-list report leading with total findings across affected files (split into raw model FAILs vs. threshold-flipped borderline findings), findings by rule sorted worst-first, top hotspot files sorted by violation count and lowest score, and skipped module checks instead of raw JSON (default: `json`).
- `--fail-on-violation` — exit with status `1` when any scored check fails (default exits `0` on scored runs; scoring, transport, or backend errors always exit with status `2`, and invalid CLI arguments/inputs exit with status `1`).
- `--concurrency N` — set maximum concurrent per-file requests in `--mode file`.
- `--allow-credentials` — override the best-effort heuristic credential check after reviewing a false positive (never overrides an embedded `OPENROUTER_API_KEY`).

Select a regular `.kt`, `.ts`, `.tsx`, `.mts`, or `.cts` file or a directory of production sources (or a directory for `--mode structure`). Directory selection skips symlinks, hidden entries (except React Router's `.server` and `.client` folders), conventional build/generated/dependency directories (`node_modules`, `vendor`, `build`, `dist`, `out`, `target`, `coverage`, `generated`), and paths matched by `--ignore <glob>`. Universal cross-language test and test-support conventions (`test/`, `tests/`, `testing/`, `__tests__/`, `__mocks__/`, `__fixtures__/`, `testFixtures/`, `fixtures/`, `androidTest/`, `*.test.*`, `*.spec.*`, `*.mock.*`, `*_test.*`, `*_spec.*`, `*Test.*`, `*Tests.*`, `*Spec.*`, `conftest.py`, `test_*.py`) are excluded in `code`/`file` modes and classified as `test` in `--mode structure`. Use `--ignore <glob>` to exclude repo-specific helpers, fixtures, or generated files. A 128 KiB input limit applies (combined in `code`/`structure` modes; per individual file plus optional documents in `--mode file`). Review `request.json` before live runs for secrets.

Live scoring defaults to [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) with `liquid/d1.2-ultra` for `code` and `structure` modes and `typesafe/jev-1.14` for `--mode file` (override either with `--model`), using `OPENROUTER_API_KEY` in the environment, with bounded exponential backoff retries on transient HTTP `429`/`502`/`503`/`504` responses.

When `OPENROUTER_API_KEY` is unavailable, pass `--backend codex` (uses `gpt-6-luna` at `low` reasoning effort) or `--backend claude` (uses `haiku` with thinking disabled via `MAX_THINKING_TOKENS=0`) explicitly to score through the locally authenticated CLI using structured outputs (`pass` / `borderline` / `fail` with a 1-sentence `note` per check, adapted to the same `result.json` shape with `pass_probability: null` and `borderline` mapped to `choice: "fail"`). Keep the same `--backend` across before-and-after runs so scores remain comparable.

The CLI writes only into a new private output directory (`0700` dir, `0600` files): `request.json`, `response.txt` (redacting the API key if echoed), and `result.json` (in `--mode file`, top-level `result.json` plus per-file `files/<slug>/{request.json,response.txt,result.json}`). Keep these artifacts private because they contain source code. Dry runs write `request.json` and an unscored `result.json` locally.
