# Repository guidance

## Package-manager examples

Use `pnpm dlx` as the primary example for one-off CLI commands in this repository's setup documentation. Keep `npx` documented as the npm alternative. When applying skills to another repository, follow that repository's declared package manager and conventions; do not switch package managers to match these examples. For tools already installed in a pnpm project, use `pnpm exec` or the project's existing scripts instead of `pnpm dlx`.

## Authoritative rubrics and testing

Top-level `rubrics/` is the single authoritative source for all shared rubrics in this repository (both `judge-code` production/structure rubrics and eval `test_code` rubrics).

- **Never edit `skills/judge-code/rubrics/*.json` directly.** Always edit the authoritative files under `rubrics/*.json` and run `pnpm sync:rubrics` to mirror the shipped subset (`target: "production_code"` and `target: "project_structure"`) into `skills/judge-code/rubrics/`. Keeping that mirrored copy ensures `skills/judge-code/` stays self-contained when installed via the Skills CLI.
- **Offline tests (`pnpm test`):** runs all repository unit tests (including `judge-code`, `repo-setup`, `evals/code-change`, the SHA-256 parity check between `rubrics/` and `skills/judge-code/rubrics/`, and `rubrics/test-rubrics.mts --dry-run`) completely offline with no API key required.
- **Live rubric fixture tests (`pnpm test:rubrics`):** unified dual-mode harness evaluating curated good/bad real-file fixtures under `rubrics/fixtures/<rubric>/<fixture-id>/{fixture.json,files/}` (plus optional `context/`, `requirements.md`, `conventions.md`) against all 65 criteria across all 15 authoritative `rubrics/*.json` rubrics (live via OpenRouter using `OPENROUTER_API_KEY`, or `--backend codex|claude`, or `--dry-run` offline). Runs every `production_code` and `test_code` fixture in both `file` mode (`typesafe/jev-1.14`, overrideable with `--file-model`) and `module` mode (`liquid/d1.2-ultra`, overrideable with `--module-model`) narrowed to expected check IDs, gates `file`-scoped checks on both modes and `module`-scoped checks on `module` mode while reporting `file` mode as informational signal, evaluates `project_structure` fixtures directly from `files/` in `structure` mode, and prints a Scope Signal Matrix (`criteria_matrix` in `--json`). Supports `--repeats N`, `--fixture <id>`, `--rubric <slug>`, `--rule <check_id>`, `--modes both|file|module`, `--file-model <id>`, `--module-model <id>`, and `--model <id>`.
- **Local rubric scanner & offline dashboard (`pnpm rubrics:scan`, `pnpm rubrics:dashboard`):**
  - `pnpm rubrics:scan --config <private-config.json> [--dry-run] [--force] [--repo <name>] [--skip-fixtures] [--no-dashboard]` scans configured local repositories against authoritative `rubrics/*.json`, skips unchanged `(repo, commit, mode, sources, exclude, rubric_hashes, model)` runs, saves sanitized score-only snapshots (`0600`, no source code) to `<dataDir>/runs/`, optionally runs `rubrics/test-rubrics.mts`, and rebuilds the HTML dashboard.
  - `pnpm rubrics:dashboard --data <dir> [--out <file.html>]` builds a self-contained, zero-dependency offline HTML dashboard (trends, rubric-change markers, cross-repo check heatmap, hotspots, installed `judge-code` freshness, and fixture health) with no network calls.
  - Keep scan configs, snapshots, and generated HTML dashboards in a private directory outside this repository; never commit private repo names, paths, filenames, or scores.

## Skill versioning and releases

Use repository-wide releases for now. All skills share Git tags in the form `vMAJOR.MINOR.PATCH`, starting with `v0.1.0`. Do not introduce per-skill release tags or independent version fields unless the maintainer requests a change in policy.

Choose version increments according to the impact of changes:

- **Patch:** wording fixes and clarifications that do not materially change behavior.
- **Minor:** new skills, checks, or optional workflows that preserve existing requirements.
- **Major:** materially incompatible changes to skill requirements or behavior.

Git tags identify repository commits. Consumers select a release through its GitHub tree URL and select an individual skill with `--skill`. For example, after publishing `v0.1.0`:

```bash
pnpm dlx skills add \
  https://github.com/wombat9000/agent-tooling/tree/v0.1.0 \
  --skill test-audit
```

Do not use `owner/repo@VERSION` as version-selection syntax: the skills CLI uses `@` to select a skill.

### Automatic release tagging

When the user asks to push changes to skills, treat that request as authorization to publish a repository-wide release tag too, unless the user explicitly requests no release. A commit-only request does not authorize pushing or releasing.

1. Check local and remote tags and identify skill changes since the latest release.
2. Choose the next version using this document's versioning rules.
3. Validate the changes and confirm the intended release commit.
4. Create an annotated tag at that commit, then push the branch and tag.
5. Report the pushed commit and release tag. If either push fails, report the partial result rather than claiming the release succeeded.

Skip tagging for repository-documentation-only changes and repo-internal skills under `.agents/skills/` (marked `metadata.internal: true`). Changes to published skill instructions and bundled supporting documents under `skills/` count as skill changes, not repository-documentation-only changes.

Never move or overwrite a published release tag; publish a new version instead. Outside the authorization described above, commit, tag, push, or publish a release only when the user authorizes the action.
