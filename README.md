# agent-tooling

Reusable skills for AI coding agents. Install a skill in the project where you want to use it, then ask your agent to apply it.

## Skills

Reusable agent skills live under `skills/`. Each skill has an entry-point document and may include supporting guidance.

- [repo-setup](<skills/repo-setup/SKILL.md>): opt-in repository guardrails. Bundles a dependency-free directory-size check with warning and error thresholds, scoped exclusions, and documented exceptions. Previews existing violations and asks separately before CI integration.
- [adr](<skills/adr/SKILL.md>): evidence-grounded guidance for consulting, drafting, reviewing, and superseding architecture decision records. Includes a [Nygard template](<skills/adr/assets/adr-template.md>).
- [test-audit](<skills/test-audit/SKILL.md>): language-neutral guidance for writing valuable tests, auditing existing coverage, and reviewing a subsystem's complete test surface. Includes a [campaign procedure](<skills/test-audit/CAMPAIGN.md>).
- [node-dependency-management](<skills/node-dependency-management/SKILL.md>): npm and pnpm dependency selection, installation, upgrades, and removal. Requires verified vendor maintenance or at least 1,000 GitHub stars, substantive activity within the previous year, and a short risk-based review.
- [renovate](<skills/renovate/SKILL.md>): ecosystem-neutral dependency maintenance through bounded, parent-first upgrade batches. Supports assessment-only reports, reassesses resolution exceptions, and requires validation evidence.
- [code-change](<skills/code-change/SKILL.md>): implements and reviews code changes in one style. Implement mode carries a change through verification, review (defaulting to [judge-code](<skills/judge-code/SKILL.md>) when available, with an independent-review fallback), and resolution of findings; review mode returns evidence-backed findings with defined severities. Both modes share one style guide of numbered Rules and Defaults, with [module-design](<skills/code-change/guidance/module-design.md>), [domain-modelling](<skills/code-change/guidance/domain-modelling.md>), [testing](<skills/code-change/guidance/testing.md>) ([unit](<skills/code-change/guidance/testing-unit.md>), [integration](<skills/code-change/guidance/testing-integration.md>), [e2e](<skills/code-change/guidance/testing-e2e.md>)) and [Kotlin](<skills/code-change/guidance/kotlin.md>) guidance read only when applicable.
- [judge-code](<skills/judge-code/SKILL.md>): linter-first CLI for Kotlin and TypeScript code quality. Treats its bundled `rubrics/*.json` as an open, executable style guide (with `Rule criteria:` legends on findings, `judge-code explain <rule...>`, and `judge-code list --verbose`), linting files/directories or `--changed` git diffs by default (`typesafe/jev-1.14`, `--deep` for `liquid/d1.2-ultra`), plus explicit `module <path...>` architectural scans and `structure <path>` layout checks, with auto-discovered `AGENTS.md`, ESLint-style `error` vs. `warning` output, standard `0`/`1`/`2` exit codes, and a dependency-free local dry run.

## Evaluations

[evals/code-change](<evals/code-change/README.md>) measures whether the `code-change` skill makes agents' reviews and implementations better and more consistent. The tasks depend on no harness and run with [Harbor](https://github.com/harbor-framework/harbor).

See the checked-in [eval scorecard](<evals/SCORECARD.md>) for current skill coverage, baseline-vs-skill scores, and content-hash freshness across all tasks. Run `pnpm eval scorecard --open` to open the interactive offline HTML dashboard (`eval-results/scorecard.html`), `pnpm eval scorecard build` to regenerate `evals/SCORECARD.md` and the HTML dashboard, or `pnpm eval scorecard record <judge-dir...>` to record new judge runs.

Run `pnpm eval check` for offline checks, `pnpm eval canary` for one Codex trial, or
`pnpm eval --help` for all terminal commands. See the [eval quick start](evals/code-change/README.md#quick-start)
for Docker checks, baseline runs, and OpenRouter scoring. `pnpm eval report --latest --open`
opens an HTML report of saved judge scores and rubric criteria without another API call.

## Rubric Fixture Harness

Verify all 52 criteria across all 13 authoritative `rubrics/*.json` rubrics (32 `production_code`, 7 `project_structure`, and 13 `test_code`) against curated real-file pass/fail fixtures under `rubrics/fixtures/<rubric>/<fixture-id>/`:

- Each fixture directory contains `fixture.json` (metadata and `expect` verdicts only—no inline code strings), a `files/` directory of real `.ts`/`.tsx`/`.kt` source files on disk, and optional `context/` (read-only `production_files_context` for `test_code` fixtures), `requirements.md`, and `conventions.md`.
- `pnpm test:rubrics [--dry-run] [--repeats N] [--fixture ID] [--rubric SLUG] [--rule CHECK_ID] [--modes both|file|module] [--file-model ID] [--module-model ID] [--model ID] [--backend openrouter|codex|claude] [--json]`
- Both `production_code` and `test_code` fixtures run in **both** `file` mode (per-file scoring aggregated via all-files-pass, default `typesafe/jev-1.14`) and `module` mode (bundled scoring, default `liquid/d1.2-ultra`), narrowed strictly to each fixture's expected check ID(s) and ignoring criterion `scope` filtering in `file` mode so module-scoped checks also report single-file signal.
- `file`-scoped checks require both `file` and `module` modes to pass across all repeats; `module`-scoped checks require `module` mode and report `file` mode as informational signal; `project_structure` fixtures read their `files/` directory tree directly in `structure` mode only.
- Outputs per-fixture tables (Production, Test Code, and Project Structure) plus a **Scope Signal Matrix** (also emitted as `criteria_matrix` in `--json`) classifying every dual-mode criterion (`production_code` + `test_code`) as `both` (with a `promote?` hint for `module`-scoped criteria), `module-only`, `file-only`, or `neither`.

## Local Rubric Scanner & Offline Dashboard

Track code-quality rubric scores across local repositories and `rubrics/fixtures/` health over time without committing private repository data:

- `pnpm rubrics:scan --config /path/to/private/config.json [--dry-run] [--force] [--repo <name>] [--modules | --skip-modules] [--module-root <dir>] [--skip-fixtures] [--no-dashboard]` — scans configured local repositories against authoritative `rubrics/*.json`, caches unchanged `(repo, commit, mode, sources, modules, exclude, ignore, rubric_hashes, model)` runs at $0 cost, stores score-only JSON snapshots (never source code) in `<dataDir>/runs/`, and rebuilds the offline dashboard.
- `pnpm rubrics:dashboard --data /path/to/private/data [--out /path/to/index.html]` — regenerates the self-contained, single-file offline HTML dashboard (linter-style punch-list overview with `errors` vs. `warnings`, Feature / Module Architecture breakdown, inline SVG trend charts with rubric/judge change markers, worst-offending rules, hotspot files, cross-repo check heatmap, installed `judge-code` version check, and fixture health) directly from saved snapshots.

### Optional feature / module architectural scanning

`file` mode evaluates file-scoped checks and `structure` mode evaluates directory layout, leaving module-scoped architectural rubrics (`single_responsibility`, `boundary_separation`, `dependency_inversion`, `domain_invariants`, `no_duplicated_code`, `modular_organization`, etc.) unscored unless a repo opts into module scanning.

Add optional `modules` and/or `moduleRoots` to any repository entry in your private `config.json` (both are language- and repo-agnostic, and existing configs without them continue working unchanged):

```json
{
  "dataDir": "/path/to/private/rubric-data",
  "repos": [
    {
      "name": "example-app",
      "path": "/path/to/example-app",
      "sources": ["src"],
      "modes": ["file", "structure"],
      "ignore": ["*-test-support.*"],
      "conventions": "docs/conventions.md",
      "moduleRoots": ["src/features/*"],
      "modules": [
        { "name": "billing", "path": "src/features/billing", "ignore": ["legacy/**"] },
        { "name": "core-domain", "path": "src/domain" }
      ],
      "moduleModel": "liquid/d1.2-ultra"
    }
  ]
}
```

- `moduleRoots`: repo-relative directory roots or single-segment `*` wildcards (e.g., `"app/features"`, `"app/features/*"`, `"src/main/kotlin/com/acme/*"`, or `"packages/*/src/features/*"`). Auto-discovers immediate code subdirectories, skipping hidden/build/test/ignored directories and directories with no production source files.
- `modules`: explicit module declarations as strings (`"src/domain"`) or objects (`{ "name"?, "path", "ignore"? }`). Explicit entries override auto-discovered entries at the same path (useful for attaching per-module `ignore` globs or custom names).
- When `modules` or `moduleRoots` is configured (or `--modules` / `--module-root` is passed on the CLI), `rubrics:scan` evaluates each module with module-level (`code`) checks, forwarding repo `conventions` and merged repo + module `ignore` globs. Modules that exceed `judge-code`'s 128 KiB input budget or contain no production files are recorded as skipped (`oversize` / `empty`) with size diagnostics instead of failing the rest of the scan. Pass `--skip-modules` to bypass module scans on a run.

## Install skills

Use the [Vercel Skills CLI](https://github.com/vercel-labs/skills) with Node.js, Git, and either pnpm or npm available. Prefer `pnpm dlx` in pnpm projects; use `npx` in npm projects. Both commands may download and run the CLI without adding it to the project's dependencies. Review the skill instructions before installing them.

The examples below use `pnpm dlx`. If you use npm, replace `pnpm dlx` with `npx` in any example; keep the remaining arguments unchanged.

Run these commands from the **target project's root**, not necessarily this repository.

### Choose skills interactively

```bash
pnpm dlx skills add wombat9000/agent-tooling
```

With npm, use this equivalent command instead:

```bash
npx skills add wombat9000/agent-tooling
```

Follow the prompts to select skills and target agents. Installation is project-local by default. Add `--global` to make skills available across projects for the selected agents.

To list available skills without installing them:

```bash
pnpm dlx skills add wombat9000/agent-tooling --list
```

### Select a skill and agent

```bash
# Install the ADR skill for Claude Code.
pnpm dlx skills add wombat9000/agent-tooling --skill adr --agent claude-code

# Install the test-audit skill for Codex.
pnpm dlx skills add wombat9000/agent-tooling --skill test-audit --agent codex
```

Omit `--agent` to choose interactively. See the CLI's [supported agents](https://github.com/vercel-labs/skills#supported-agents) for other identifiers. Remote commands install only content already pushed to GitHub.

### Install the implementation and review skill

```bash
pnpm dlx skills add wombat9000/agent-tooling --skill code-change
```

`code-change` replaces `implementing-changes`, `reviewing-changes`, `reviewing-design` and `writing-code`. Remove those skills when you install it, so that agents do not load both. Preserve the full skill directory, including `modes/` and `guidance/`.

### Install the code-quality judging skill

```bash
pnpm dlx skills add wombat9000/agent-tooling --skill judge-code
```

The [judge-code instructions](<skills/judge-code/SKILL.md>) include the standalone invocation, open rubric style-guide commands (`list --verbose`, `explain <check-id...>`), input filters, and OpenRouter data-sharing details.

### Select a release

The shorthand commands above use the repository's default branch. For a specific release, use its GitHub tree URL and select the skill separately:

```bash
pnpm dlx skills add \
  https://github.com/wombat9000/agent-tooling/tree/v0.1.0 \
  --skill test-audit
```

This example selects the published `v0.1.0` release, which contains `test-audit`. Choose a [published tag](https://github.com/wombat9000/agent-tooling/tags) that includes the skill you need. All skills share repository-wide release tags. Do not use `owner/repo@VERSION`: the CLI uses `@` to select a skill, not a release.

### Install from a local checkout

To try local changes before they are pushed, run this from your target project, replacing the path with your checkout:

```bash
pnpm dlx skills add /path/to/agent-tooling --skill adr
```

If your agent is not supported by the CLI, use its documented skill-loading mechanism. Preserve the complete skill directory, including supporting documents and templates; loading only the entry-point document can leave required references unavailable.

## Use the skills

After installation, check that your agent discovers the skill. Reload its session if its documentation requires it. Invocation syntax varies by agent; you can explicitly request the skill in your prompt:

- “Use the repo-setup skill to preview a directory-size check. Warn above 20 files and error above 30. Ask before installing it or changing CI.”
- “Use the adr skill to draft a proposed ADR for our database choice. Ask about missing rationale before writing.”
- “Use the adr skill to check whether this change conflicts with existing decisions.”
- “Use the test-audit skill to review the authentication tests. Report findings without editing files.”
- “Use the node-dependency-management skill to evaluate a package before adding it. Do not install packages that fail its eligibility gates without my explicit approval.”
- “Use the renovate skill to assess dependency drift in this project. Do not edit files. Recommend one coherent upgrade batch and its validation plan.”
- “Use the code-change skill to implement this change. Do not commit or push.”
- “Use the code-change skill to review this branch against its requirements. Do not edit files.”
- “Use the code-change skill to review the design of the billing module only.”
- “Use the judge-code skill to score the booking module against the module-design and readability rubrics. Preview the files and criteria first.”

Provide the task scope and say whether you want a review or file changes. Skills supply instructions; they do not grant extra tool permissions or authorize commits and releases.

To inspect installed skills:

```bash
pnpm dlx skills list
```

If a skill does not appear in your agent, check the selected agent, installation scope, and that agent's skill-loading requirements. Cloning this repository alone does not register its skills with an agent.
