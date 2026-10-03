# agent-tooling

Reusable skills for AI coding agents. Install a skill in the project where you want to use it, then ask your agent to apply it.

## Skills

Reusable agent skills live under `skills/`. Each skill has an entry-point document and may include supporting guidance.

- [adr](<skills/adr/SKILL.md>): evidence-grounded guidance for consulting, drafting, reviewing, and superseding architecture decision records. Includes a [Nygard template](<skills/adr/assets/adr-template.md>).
- [test-audit](<skills/test-audit/SKILL.md>): language-neutral guidance for writing valuable tests, auditing existing coverage, and reviewing a subsystem's complete test surface. Includes a [campaign procedure](<skills/test-audit/CAMPAIGN.md>).
- [node-dependency-management](<skills/node-dependency-management/SKILL.md>): npm and pnpm dependency selection, installation, upgrades, and removal. Requires verified vendor maintenance or at least 1,000 GitHub stars, substantive activity within the previous year, and a short risk-based review.

## Install skills

Use the [Vercel Skills CLI](https://github.com/vercel-labs/skills) with Node.js, npm, and Git available. The commands below use `npx`, which may download and run the CLI. Review the skill instructions before installing them.

Run these commands from the **target project's root**, not necessarily this repository.

### Choose skills interactively

```bash
npx skills add wombat9000/agent-tooling
```

Follow the prompts to select skills and target agents. Installation is project-local by default. Add `--global` to make skills available across projects for the selected agents.

To list available skills without installing them:

```bash
npx skills add wombat9000/agent-tooling --list
```

### Select a skill and agent

```bash
# Install the ADR skill for Claude Code.
npx skills add wombat9000/agent-tooling --skill adr --agent claude-code

# Install the test-audit skill for Codex.
npx skills add wombat9000/agent-tooling --skill test-audit --agent codex
```

Omit `--agent` to choose interactively. See the CLI's [supported agents](https://github.com/vercel-labs/skills#supported-agents) for other identifiers. Remote commands install only content already pushed to GitHub.

### Select a release

The shorthand commands above use the repository's default branch. For a specific release, use its GitHub tree URL and select the skill separately:

```bash
npx skills add \
  https://github.com/wombat9000/agent-tooling/tree/v0.1.0 \
  --skill test-audit
```

This example selects the published `v0.1.0` release, which contains `test-audit`. Choose a [published tag](https://github.com/wombat9000/agent-tooling/tags) that includes the skill you need. All skills share repository-wide release tags. Do not use `owner/repo@VERSION`: the CLI uses `@` to select a skill, not a release.

### Install from a local checkout

To try local changes before they are pushed, run this from your target project, replacing the path with your checkout:

```bash
npx skills add /path/to/agent-tooling --skill adr
```

If your agent is not supported by the CLI, use its documented skill-loading mechanism. Preserve the complete skill directory, including supporting documents and templates; loading only the entry-point document can leave required references unavailable.

## Use the skills

After installation, check that your agent discovers the skill. Reload its session if its documentation requires it. Invocation syntax varies by agent; you can explicitly request the skill in your prompt:

- “Use the adr skill to draft a proposed ADR for our database choice. Ask about missing rationale before writing.”
- “Use the adr skill to check whether this change conflicts with existing decisions.”
- “Use the test-audit skill to review the authentication tests. Report findings without editing files.”
- “Use the node-dependency-management skill to evaluate a package before adding it. Do not install packages that fail its eligibility gates without my explicit approval.”

Provide the task scope and say whether you want a review or file changes. Skills supply instructions; they do not grant extra tool permissions or authorize commits and releases.

To inspect installed skills:

```bash
npx skills list
```

If a skill does not appear in your agent, check the selected agent, installation scope, and that agent's skill-loading requirements. Cloning this repository alone does not register its skills with an agent.
