---
name: judge-code
description: Score a production Kotlin or TypeScript module against binary code-quality rubrics and optional repo conventions, inspect failed checks directly in source, and guide small behavior-preserving refactors. Use for rubric-based quality assessment or before-and-after scoring.
---

# Judge production code

1. Select the smallest production module that still shows the relevant relationships, along with any applicable rubrics (`--rubric`, `--all`, or a local `.json` rubric), optional `--requirements` or `--conventions` documents, and `--exclude` for checks that conflict with the repository's framework or conventions. Confirm the caller has authorization to share the selected contents with OpenRouter and the chosen model provider before a live run.
2. Run the bundled CLI with `--dry-run`. Inspect `request.json` for the complete numbered files, optional documents, and resolved criteria. Narrow the selection if anything is unrelated or confidential.
3. Run with the same inputs, a fresh output directory, and `--dry-run` removed. Read `result.json` for pass/fail choices, `P(pass)`, and confidence, and check `request.json` for the exact criteria of any failed checks. Inspect the current source directly to verify whether each failed check reflects a real issue before reporting it or making a change.
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
- `--mode structure` (or `--rubric project-structure`) — score a directory's folder layout, sub-feature grouping, and concern separation using a compact structural manifest (directory counts, file line counts, exports, and imports) instead of sending full file bodies.
- `--all` — include all bundled rubrics for the active mode (combine with `--exclude <check_id>` to drop checks that do not fit the codebase).
- `--rubric path/to/custom.json` — load a repo-local binary rubric using the same `{ rubric, questions }` JSON schema (set `"target": "project_structure"` for structure-mode rubrics). Bundled rubrics accept short names (`module-design`, `project-structure`) or pinned version IDs (`module-design-v2`).
- `--requirements FILE` — optional Markdown or plain text requirements/spec document.
- `--conventions FILE` — optional Markdown or plain text coding conventions document. Adds `state.conventions` with precedence over conflicting bundled criteria and includes a `follows_repo_conventions` check (which can be suppressed with `--exclude follows_repo_conventions` if you only want precedence).
- `--allow-credentials` — override the best-effort heuristic credential check after reviewing a false positive (never overrides an embedded `OPENROUTER_API_KEY`).

Select a regular `.kt`, `.ts`, `.tsx`, `.mts`, or `.cts` file or a directory of production sources (or a directory for `--mode structure`). Directory selection skips symlinks, hidden entries (except React Router's `.server` and `.client` folders), and conventional build, generated, and dependency directories inside `--source` (plus test directories in code mode). A combined 128 KiB input limit applies. Review `request.json` before live runs for secrets or proprietary content.

Live scoring sends a single request to [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) with `liquid/d1.2-ultra` by default (override with `--model`). Set `OPENROUTER_API_KEY` in the environment.

The CLI writes only into a new private output directory (`0700` dir, `0600` files): `request.json`, `response.txt` (redacting the API key if echoed), and `result.json`. Keep these artifacts private because they contain source code. Dry runs write `request.json` and an unscored `result.json` locally.
