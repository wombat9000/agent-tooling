# Implement mode

Take a requested change from clear requirements to verified, reviewed code.

## 1. Establish the requirements

Read the request, the repository instructions, and the code you will change.
State the observable outcome and how you will verify it.

Ask the user only when an ambiguity would change observable behavior, a public
interface, or stored data. Otherwise choose the reading that fits the request and
existing code, and list the assumption in the handoff.

Find the project's verification commands in its package scripts, Makefile, CI
configuration or README. Use the tests, type checks, linters and build that CI
runs for the affected code.

## 2. Build

Read the style guide files that apply (see the table in `SKILL.md`) before
writing code, and follow them while writing, not only afterwards.

- Make the smallest change that satisfies the requirements. Leave unrelated
  improvements out and mention them in the handoff instead.
- Write a general solution, not one shaped to pass specific tests. If a test
  looks wrong, report it rather than working around it.
- When a refactoring is needed, first make the behavior-preserving change and
  verify it with the existing tests, then change behavior.
- Write tests that follow `T1`–`T4`.

## 3. Verify

Run the verification commands and read their output. Record each as
`command → result`. When a check fails, fix the cause; when it also fails
without your change, say so and leave it. List any check you could not run and
what therefore remains unverified.

## 4. Get a review

**Delegate the review** when any of these apply:

- Production code changed in two or more files.
- A public interface changed: an exported API, schema, CLI, configuration or wire format.
- A new module, class or file with its own responsibility was added.
- The change touches persistence, concurrency, authentication, authorization or money.
- The user asked for a review.

Otherwise, review the change yourself by following `modes/review.md`.

To delegate, start a subagent with fresh context and, where the harness allows,
read-only tools. A reviewer who did not write the code is less likely to share
the author's blind spots. Fill in this brief:

```text
Review a code change. Use the code-change skill in review mode: read
<path to this skill>/SKILL.md, then <path to this skill>/modes/review.md.
This is an assessment only; do not edit files.

Scope: full

Requirements:
<the user's request and acceptance criteria, verbatim where possible>

Changed files, including new untracked files:
<paths>   Diff base: <commit or branch>

Repository instructions to respect: <paths, e.g. AGENTS.md>

Verification already run:
<command> → <result>
```

Leave out your opinion of the code's quality, your preferred design, and any
earlier review findings: they anchor the reviewer. If delegation is unavailable
or the user prohibited it, review the change yourself and say in the handoff
that the review was a self-review.

## 5. Resolve findings

Assess each finding before acting on it:

- **Blocking**: fix it.
- **Should fix**: fix it, or explain in the handoff why the departure is justified.
- **Optional**: your choice. Optional findings never expand the task's scope.

Rerun the affected checks after fixes. Request one targeted re-review only when a
Blocking fix changed behavior. If the reviewer and you still disagree after that,
report the disagreement to the user instead of looping.

## 6. Hand off

Report in this shape:

```text
Summary: what changed and why (2–4 lines)
Verification: command → result, one per line; checks not run and why
Review: delegated | self-review
  - <finding title> (<severity>): fixed | declined because <reason>
Assumptions and limitations: …
State: uncommitted changes on <branch> | committed <sha>
```
