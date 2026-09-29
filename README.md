# agent-tooling

Tools for AI agents.

## Skills

Reusable agent skills live under `skills/`. Each skill has an entry-point document and may include supporting guidance.

- [test-audit](<skills/test-audit/SKILL.md>): language-neutral guidance for writing valuable tests, auditing existing coverage, and reviewing a subsystem's complete test surface. Includes a [campaign procedure](<skills/test-audit/CAMPAIGN.md>).

Load the skill's entry-point document in your agent's supported skill mechanism. These files do not register themselves with a particular agent runtime.
