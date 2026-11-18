# agent-tooling

Reusable skills for AI coding agents. Install a skill in the project where you want to use it, then ask your agent to apply it.

## Skills

Reusable agent skills live under `skills/`. Each skill has an entry-point document and may include supporting guidance.

- [repo-setup](<skills/repo-setup/SKILL.md>): opt-in repository guardrails. Bundles a dependency-free directory-size check with warning and error thresholds, scoped exclusions, and documented exceptions. Previews existing violations and asks separately before CI integration.
- [adr](<skills/adr/SKILL.md>): evidence-grounded guidance for consulting, drafting, reviewing, and superseding architecture decision records. Includes a [Nygard template](<skills/adr/assets/adr-template.md>).
- [test-audit](<skills/test-audit/SKILL.md>): language-neutral guidance for writing valuable tests, auditing existing coverage, and reviewing a subsystem's complete test surface. Includes a [campaign procedure](<skills/test-audit/CAMPAIGN.md>).
- [node-dependency-management](<skills/node-dependency-management/SKILL.md>): npm and pnpm dependency selection, installation, upgrades, and removal. Requires verified vendor maintenance or at least 1,000 GitHub stars, substantive activity within the previous year, and a short risk-based review.
- [renovate](<skills/renovate/SKILL.md>): ecosystem-neutral dependency maintenance through bounded, parent-first upgrade batches. Supports assessment-only reports, reassesses resolution exceptions, and requires validation evidence.
- [writing-code](<skills/writing-code/SKILL.md>): shared principles for readable, direct code, with [Kotlin conventions](<skills/writing-code/reference/kotlin.md>), [domain modelling](<skills/writing-code/reference/domain-modelling.md>) and [module-design guidance](<skills/writing-code/reference/module-design.md>) read only when applicable. Keeps construction guidance separate from implementation and review workflows.
- [implementing-changes](<skills/implementing-changes/SKILL.md>): carries a change through implementation, verification, independent review and resolution. Uses `writing-code`, `reviewing-changes` and `reviewing-design`; scales review to the change and provides a self-review fallback when delegation is unavailable.
- [reviewing-changes](<skills/reviewing-changes/SKILL.md>): read-only correctness, test-quality and design assessment. Uses `writing-code` and `reviewing-design`; returns evidence-backed findings for the implementer to resolve.
- [reviewing-design](<skills/reviewing-design/SKILL.md>): read-only assessment of responsibility boundaries, caller obligations and locality against `writing-code`. Requires concrete costs and justified alternatives rather than a preferred architecture.

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

### Install the implementation workflow

Install the workflow and its companion skills together in the same scope so their relative links resolve:

```bash
pnpm dlx skills add \
  https://github.com/wombat9000/agent-tooling/tree/v0.7.0 \
  --skill implementing-changes reviewing-changes reviewing-design writing-code
```

For review without implementation, install `reviewing-changes`, `reviewing-design` and `writing-code`. For design assessment alone, install `reviewing-design` and `writing-code`. `writing-code` can be used independently. All four are available from `v0.7.0`; selecting one skill does not install its companions automatically. Preserve each skill's full directory, including references, and use the same release for the companion set.

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
- “Use the writing-code skill to implement this change. Read its Kotlin reference for Kotlin work and its module-design reference when choosing responsibility boundaries.”
- “Use implementing-changes to implement this change, verify it, obtain a read-only review and resolve warranted findings. Do not commit or push.”
- “Use reviewing-changes to assess this implementation against its requirements. Report correctness, test-quality and design findings without editing files.”
- “Use reviewing-design to assess the responsibility boundaries in this module. Report concrete friction and the smallest useful alternatives without editing files.”

Provide the task scope and say whether you want a review or file changes. Skills supply instructions; they do not grant extra tool permissions or authorize commits and releases.

To inspect installed skills:

```bash
pnpm dlx skills list
```

If a skill does not appear in your agent, check the selected agent, installation scope, and that agent's skill-loading requirements. Cloning this repository alone does not register its skills with an agent.
