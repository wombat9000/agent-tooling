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

### Automatic release tagging

When the user asks to push changes to skills, treat that request as authorization to publish a repository-wide release tag too, unless the user explicitly requests no release. A commit-only request does not authorize pushing or releasing.

1. Check local and remote tags and identify skill changes since the latest release.
2. Choose the next version using this document's versioning rules.
3. Validate the changes and confirm the intended release commit.
4. Create an annotated tag at that commit, then push the branch and tag.
5. Report the pushed commit and release tag. If either push fails, report the partial result rather than claiming the release succeeded.

Skip tagging for repository-documentation-only changes. Changes to skill instructions and bundled supporting documents count as skill changes, not repository-documentation-only changes.

Never move or overwrite a published release tag; publish a new version instead. Outside the authorization described above, commit, tag, push, or publish a release only when the user authorizes the action.
