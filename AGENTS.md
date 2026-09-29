# Repository guidance

## Skill versioning and releases

Use repository-wide releases for now. All skills share Git tags in the form `vMAJOR.MINOR.PATCH`, starting with `v0.1.0`. Do not introduce per-skill release tags or independent version fields unless the maintainer requests a change in policy.

Choose version increments according to the impact of changes:

- **Patch:** wording fixes and clarifications that do not materially change behavior.
- **Minor:** new skills, checks, or optional workflows that preserve existing requirements.
- **Major:** materially incompatible changes to skill requirements or behavior.

Git tags identify repository commits. Consumers select a release through its GitHub tree URL and select an individual skill with `--skill`. For example, after publishing `v0.1.0`:

```bash
npx skills add \
  https://github.com/wombat9000/agent-tooling/tree/v0.1.0 \
  --skill test-audit
```

Do not use `owner/repo@VERSION` as version-selection syntax: the skills CLI uses `@` to select a skill.

Create annotated release tags only from the intended committed and validated revision. Never move or overwrite a published release tag; publish a new version instead. Commit, tag, push, or publish a release only when the user authorizes the action. This guidance does not authorize a release.
