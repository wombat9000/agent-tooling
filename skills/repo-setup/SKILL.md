---
name: repo-setup
description: "Use when setting up reusable repository checks or guardrails. Offers an opt-in, dependency-free directory-size check with configurable warning and error thresholds, scoped exclusions, and documented exceptions. Detects existing tooling, reports existing violations, and asks separately before changing CI."
---

# Repo setup

Install repository checks that run without an agent or this skill. Start with the directory-size check; do not add unrelated tooling as part of setup.

## Scope and authority

A setup request permits inspection and a proposed setup. Confirm the selected check, scope, thresholds, and file changes before installing it. Ask separately before adding or changing continuous integration (CI). Do not install packages, switch package managers, reorganize source files, commit, tag, push, or release merely to follow this skill.

The bundled script is the canonical implementation. Copy it into the target repository rather than linking to the installed skill or depending on `agent-tooling` at runtime. Node.js 20 or newer is required. No third-party packages, package installation, TypeScript compilation, or network access are needed to run the check. If Node.js is unavailable, report the prerequisite rather than installing it without approval.

## Inspect the target repository

1. Read applicable repository instructions. Identify source directories, generated output, vendor code, existing checks, and current CI workflows.
2. Inspect manifests, package-manager declarations, lockfiles, workspace configuration, and existing scripts. Prefer the declared package manager; if the evidence conflicts, ask. Do not assume npm, pnpm, a JavaScript project, GitHub Actions, or a particular default branch.
3. Check whether a directory-size check already exists. Reuse a compatible check rather than installing a duplicate. Read any existing destination files before proposing replacements.
4. Offer the check as an opt-in. Propose the defaults below and source roots that fit the repository. Make built-in exclusions visible. Do not silently narrow scope to hide violations.

## Configure the directory-size check

The check counts regular files **directly inside each directory**, including tests, dotfiles, and untracked files. Child directories do not contribute to their parent's count. Each eligible directory is checked once, even when roots overlap.

Default thresholds are project guardrails, not architecture guarantees:

- **Warning:** more than 20 files; a warning-only run exits successfully.
- **Error:** more than 30 files; any directory error makes the run exit with code 1.
- Exactly 20 files is clean; 21 through 30 warns; 31 or more errors.
- Invalid configuration, missing roots, or scan failures exit with code 2. Do not interpret a failed scan as a clean result.

Use the bundled [configuration template](<assets/directory-size.config.json>). The keys are:

| Key | Default | Meaning |
| --- | --- | --- |
| `warn` | `20` | Nonnegative integer warning threshold. |
| `error` | `30` | Integer error threshold, strictly greater than `warn`. |
| `roots` | `["."]` | Nonempty list of directories to scan, relative to the target repository root. |
| `exclude` | `[]` | Entries with `path` and a nonempty `reason`. Skip that directory and its entire subtree. |
| `exceptions` | `[]` | Entries with `path` and a nonempty `reason`. Exempt only that directory's direct count; still check its children. |

Example of scoped exclusions and an exception:

```json
{
  "warn": 20,
  "error": 30,
  "roots": ["src", "tests"],
  "exclude": [
    { "path": "src/generated", "reason": "Generated client; do not edit manually." }
  ],
  "exceptions": [
    { "path": "tests/fixtures", "reason": "Flat fixture names form the test dataset." }
  ]
}
```

Paths use forward slashes, not glob patterns. Use `.` for the repository root. Absolute paths, backslashes, empty segments, and `.` or `..` segments within a path are invalid. An exclusion cannot target `.`. Unknown keys and duplicate exclusion or exception paths are errors.

The script always skips directories named `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.output`, `.cache`, and `.turbo`, at any depth. If these names contain maintained source in the target repository, adapt and review the script before adopting it. Other generated or vendor directories need explicit exclusions with reasons. The script does not read `.gitignore` or infer which files are generated.

Symbolic links are not counted or followed. Configured roots must exist and must not pass through symbolic links. This check is a development guardrail, not a sandbox for hostile or concurrently changing filesystems.

## Preview before enforcement

Before installing the check or changing CI:

1. Agree on the candidate scope and configuration. If the user does not select the check, stop without installing it.
2. Use the bundled [script](<scripts/check-directory-size.mjs>) and a task-owned temporary configuration to run the candidate check from the target repository root. Pass the temporary configuration with `--config`; all configured directory paths remain relative to the current working directory, not the configuration file's location.
3. Report existing warnings and errors, the affected directories, and the proposed file changes. A nonzero result caused by existing errors is useful preview evidence, not a setup failure.
4. If errors already exist, ask whether to reorganize them separately, add specific exceptions with reasons, adjust scope or thresholds, or defer enforcement. Do not automatically exempt every failing directory, raise thresholds to obtain a clean run, or reorganize code during setup.
5. Confirm installation with the selected policy and any accepted violations. This confirmation does not authorize CI changes.

## Install and validate

After confirmation:

1. Copy the bundled [script](<scripts/check-directory-size.mjs>) to `scripts/check-directory-size.mjs` and the selected configuration to `directory-size.config.json` in the target repository. If those paths conflict with existing files or conventions, agree on alternatives. Do not overwrite local changes or duplicate an existing check. Re-running setup should leave an already matching installation unchanged.
2. If the repository has an appropriate package manifest, add a `check:directory-size` script with the value `node scripts/check-directory-size.mjs`. Preserve other scripts and manifest formatting. For a monorepo, prefer one root-level command unless the repository's conventions require otherwise. Do not create a package manifest solely for this check or regenerate a lockfile when no dependencies change.
3. If no package manifest applies, use the direct Node command or integrate with the existing task runner after approval.
4. Run the installed command from the target repository root. For example, use `pnpm check:directory-size`, `npm run check:directory-size`, or `node scripts/check-directory-size.mjs`, according to the tooling found during inspection. A non-default configuration location requires `--config path` in the command.
5. Offer CI integration separately. Show the intended workflow change and obtain approval before editing it. Reuse an existing job with a supported Node.js runtime where practical. Preserve the script's exit code: warnings pass, directory errors and scan failures fail. Do not add `continue-on-error` or `|| true` to conceal errors.
6. Review the diff and run available validation, including `git diff --check` when Git is available. Report the installed paths, command, scope, thresholds, exceptions, actual result, and whether CI integration was requested. Distinguish accepted pre-existing violations from installation errors.

The repository owns its installed copy. For updates, compare it with the bundled canonical script, preserve deliberate local changes, preview behavior, and obtain approval before replacing it. Never update installed copies automatically or fetch code at check runtime.

## Validate this skill's implementation

From the `agent-tooling` repository root, run the bundled CLI tests with Node.js 20 or newer:

```sh
node --test skills/repo-setup/tests/check-directory-size.test.mjs
```

These tests use isolated temporary repositories and require no package installation. They validate the CLI rather than installing the check or editing a consumer repository.
