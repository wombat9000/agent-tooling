---
name: judge-code
description: Score a production module against versioned binary code-quality rubrics, verify evidence for failed checks, and guide small behavior-preserving refactors. Use for rubric-based assessment or before-and-after scoring of Kotlin or TypeScript code.
---

# Judge production code

1. Select the smallest production module that still shows the relevant relationships, its requirements document, and the rubric facets that answer the user's question. Keep the module together for whole-module scoring. Confirm the caller has authorization to share the selected contents with OpenRouter and its model providers before a live run.
2. Run the bundled CLI with `--dry-run`. Inspect `request.json` for the complete requirements, numbered files, and resolved criteria. Narrow the selection or stage an approved subset if anything is unrelated or confidential.
3. Run with the same inputs, a fresh output directory, and the dry-run flag removed. Read `result.json` for the model's pass/fail choices, P(pass), and confidence. Read `evidence.json` for proposed locations and explanations for failed checks. Verify each claim in the current source before reporting it or making a change. Unavailable evidence leaves the original decision intact.
4. If authorized to edit, use a verified failure to choose one small refactor that preserves required behavior. Run the project's checks, then re-score with the same rubric versions, model, requirements, and source scope. Compare the named checks and their evidence.

## Run the CLI

Use Node.js 22.18 or newer. Replace `$SKILL_DIR` with the installed skill directory.

```bash
node "$SKILL_DIR/scripts/judge-code.mts" --list-rubrics
node "$SKILL_DIR/scripts/judge-code.mts" \
  --source src/main/kotlin/booking --requirements requirements.md \
  --rubric module-design-v2 --rubric readability-v2 \
  --out /path/to/new-private-directory --dry-run
```

Select a regular `.kt`, `.ts`, `.tsx`, `.mts`, or `.cts` file or a directory of production sources, and a Markdown or plain text requirements file. Directory selection skips symlinks, hidden entries, and conventional test, generated, dependency, and credential paths. A best-effort credential check and a combined 128 KiB input limit apply. Review even matching files for secrets or proprietary content.

Live scoring uses [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) with `liquid/d1.2-ultra` by default. Set `OPENROUTER_API_KEY` in the environment. If any check fails, one [structured follow-up](https://openrouter.ai/docs/guides/features/structured-outputs) sends the same source and requirements with only the failed criteria to `google/gemini-3.1-flash-lite`. Use `--no-evidence` to skip that call.

The CLI writes only into a new private output directory. It saves the exact request bodies as `request.json` and, when applicable, `evidence-request.json`. It saves provider responses as `response.txt` and `evidence-response.txt`, redacting the API key if a provider echoes it. Keep these artifacts private because they can contain source and requirements. Dry runs write the Decisions request and an unscored `result.json` locally.
