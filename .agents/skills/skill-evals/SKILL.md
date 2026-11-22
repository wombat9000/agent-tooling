---
name: skill-evals
description: "Repository-internal guidance for designing, calibrating, running, and maintaining skill evaluations under evals/. Use when adding or editing eval tasks, task instructions, shared rubrics, judge tooling, or HTML reports, or when iterating on a skill using eval results."
metadata:
  internal: true
---

# Skill evals

Evaluate whether a skill actually improves agent output — without accidentally leaking the skill into the prompt or baking task specifics into reusable rubrics.

Keep four layers strictly separate:

- **Task spec (`instruction.md`):** observable contract and edge cases only.
- **Skill (`skills/<name>/`):** general engineering guidance under test.
- **Deterministic verifier (`reward.json`):** black-box correctness and required output compliance.
- **Qualitative rubric (`rubrics/*.json`, `tests/judge.json`):** craft, design, and reasoning quality scored host-side.

## 1. Task design

- **Keep guidance out of task specs:** `instruction.md` defines the observable problem, interfaces, inputs/outputs, environment constraints, and edge cases. Never mention the skill, its report format, coding style, architectural preferences, or file layout expectations. Hinting at what the skill teaches turns a skill-lift eval into a prompt-following test.
- **Keep deterministic verification behavioral:** Check compilation, hidden black-box contract tests, or required output structure in `reward.json`. Do not encode stylistic or architectural preferences as deterministic verifier failures; keep those in qualitative rubrics.
- **Pair lift tasks with restraint controls:** Whenever a skill adds or strengthens rules, maintain clean or non-triggering control tasks alongside target tasks so false-positive noise and over-enforcement surface immediately.
- **Validate wiring before spending agent runs:** Run offline checks (`pnpm eval check`) and verify Docker `oracle` (`1`) and `nop` (`0`) smoke checks when adding or changing tasks. Keep a fast canary task to verify skill loading before full runs.

## 2. Rubric design

- **Keep task domain details out of shared rubrics:** Shared rubrics under `rubrics/` must remain domain-agnostic so they compose across tasks and katas without leaking task vocabulary, domain nouns, or fixture filenames. Put task-specific checks in that task's own `tests/judge.json`.
- **Split shared rubrics into orthogonal, non-overlapping facets:** Group criteria by distinct concerns (for example, `domain-modelling`, `readability`, `module-design`, `solid`) and compose them via `extends`. Every check ID must belong to exactly one shared rubric per target; enforce zero overlap in offline self-checks.
- **Guard against cross-facet contradictions:** When facets compose on the same artifact, verify that satisfying one check never penalizes another. For example, SOLID criteria must explicitly pass clean, direct code with no custom interfaces or inheritance so they never fight a criterion against speculative abstraction.
- **Write concrete, observable binary criteria:** Anchor `pass` and `fail` criteria in inspectable properties of the artifact rather than vague adjectives. State narrow, intentional exceptions explicitly (for example, sealed type hierarchies when expecting one primary type per file).
- **Match judging scope to the rubric:** Criteria that assess file decomposition, responsibility boundaries, or cross-file structure require `whole`-codebase judging. Use `per-file` judging only when every active check can be judged fairly from a single file in isolation.

## 3. Calibration and iteration loop

1. **Change one variable at a time:** Keep rubric revisions separate from skill revisions so you know whether a score shift came from the measurement or the skill.
2. **Calibrate tightened rubrics on saved runs first:** After tightening or adding criteria, re-judge existing saved runs (`--run <dir>`) that include known good and known bad artifacts. Confirm the rubric discriminates cleanly before spending new agent trials.
3. **Compare baseline vs. skill across multiple attempts:** Run both conditions with identical model, effort, and service-tier settings across several trials (for example, 5 attempts) so variance is visible instead of reacting to a single run.
4. **Re-check restraint after strengthening rules:** When promoting a guideline to a stronger rule or adding explicit checks, verify control tasks to confirm you did not introduce false-positive findings or over-engineering.
5. **Inspect borderline passes, not only pass rates:** A `100%` pass rate with low `P(pass)` cells (for example, `65–75%`) often reveals ambiguity in the skill or rubric. Read the underlying code or review for low-confidence cells before declaring a change done.

## 4. Report and artifact invariants

- **Keep saved judgments historically immutable:** Persist the resolved rubric questions, criteria, and rubric group mapping inside saved judge artifacts (`request.json` / `result.json`). Rebuilding HTML reports (`pnpm eval report`) must use only saved data and never read today's live rubric files or make network calls.
- **Keep deterministic and qualitative scores separate:** Never blend uncalibrated LLM judge scores into Harbor's deterministic `reward.json`.
- **Keep secrets strictly host-side:** Judge credentials (`OPENROUTER_API_KEY`) stay on the host, are never passed into evaluation containers, and are never written into saved requests, results, or reports.

## Authority

This skill is repository-internal (`metadata.internal: true`) and does not authorize committing, pushing, tagging releases, or running paid API/model evaluations without user direction.
