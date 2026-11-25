# Repository guidance

## Package-manager examples

Use `pnpm dlx` as the primary example for one-off CLI commands in this repository's setup documentation. Keep `npx` documented as the npm alternative. When applying skills to another repository, follow that repository's declared package manager and conventions; do not switch package managers to match these examples. For tools already installed in a pnpm project, use `pnpm exec` or the project's existing scripts instead of `pnpm dlx`.

## Authoritative rubrics and testing

Top-level `rubrics/` is the single authoritative source for all shared rubrics in this repository (both `judge-code` production/structure rubrics and eval `test_code` rubrics).

- **Never edit `skills/judge-code/rubrics/*.json` directly.** Always edit the authoritative files under `rubrics/*.json` and run `pnpm sync:rubrics` to mirror the shipped subset (`target: "production_code"` and `target: "project_structure"`) into `skills/judge-code/rubrics/`. Keeping that mirrored copy ensures `skills/judge-code/` stays self-contained when installed via the Skills CLI.
- **Offline tests (`pnpm test`):** runs all repository unit tests (including `judge-code`, `repo-setup`, `evals/code-change`, the SHA-256 parity check between `rubrics/` and `skills/judge-code/rubrics/`, and `rubrics/test-rubrics.mts --dry-run`) completely offline with no API key required.
- **Live rubric fixture tests (`pnpm test:rubrics`):** evaluates curated good/bad code fixtures under `rubrics/fixtures/` against `judge-code`'s scoring logic (live via OpenRouter using `OPENROUTER_API_KEY`, or `--backend codex|claude`, or `--dry-run` offline). Supports `--repeats N`, `--fixture <id>`, `--rubric <slug>`, and `--model <id>`.

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
