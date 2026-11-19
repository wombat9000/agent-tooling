---
name: implementing-changes
description: "Coordinates code changes through implementation, verification, review, and resolution. Use for implementation tasks."
---

# Implementing Changes

Carry a requested change from a clear contract to a verified, reviewed result.
Scale the work to its risk and scope; small changes may need only brief checks.
Task-specific instructions supply the contract, allowed changes, verification
commands, and any restrictions on delegation.

This skill owns progression and completion conditions, not construction principles.
Load [writing-code](../writing-code/SKILL.md) and read the applicable language and
module-design references as it directs. Use [reviewing-changes](../reviewing-changes/SKILL.md) for the review pass;
keep construction principles in `writing-code` rather than duplicating them here.

## 1. Establish the contract

Read the relevant requirements, code, and repository instructions. Identify the
observable outcome, compatibility constraints, and how success will be checked.
Resolve material uncertainty before building on it without turning routine
decisions into a planning exercise.

Proceed when the intended change and its verification are clear.

## 2. Implement and verify

Make the smallest coherent change that satisfies the contract. Apply construction
guidance while building, not only after the code is written.

Run the relevant checks and inspect their results. Derive expected behavior from
the contract rather than the implementation. During refactoring, preserve behavior
and verify it with existing contract tests before changing behavior separately.

Proceed to review when implementation is complete and verification evidence is
available. State any checks that could not run and what remains unverified.

## 3. Review the result

For substantive changes, obtain a fresh-context review through a read-only
subagent on the same checkout before handing off. If delegation is prohibited or
unavailable, load `reviewing-changes`, review the result yourself and disclose that limitation. Keep
implementation and corrections with the implementer; the reviewer assesses code,
not edits it.

Supply the requirements, relevant code paths or diff (including new files),
repository constraints, applicable construction guidance, and verification
evidence. Explicitly instruct the reviewer to load the accompanying `reviewing-changes`
and follow its correctness, test-quality and design assessment, including its
`writing-code` and `reviewing-design` routing. Do not supply the author's quality
verdict or a preferred architecture; keep previous review findings out of the
initial review. The reviewer follows the assessment skill, not this orchestration
workflow. For small changes reviewed without delegation, apply the same assessment
at a proportionate scope.

## 4. Resolve and hand off

Assess findings before acting. Fix substantiated problems; explain why disputed
findings or optional alternatives do not warrant a change. A review recommendation
is not authorization to expand the requested scope.

Rerun affected checks after corrections. Re-review the correction where needed,
not the entire implementation by default. Do not repeat resolved findings or loop
until no further suggestions are possible. If review keeps generating work,
reconsider the scope or approach and surface the unresolved decision.

Before handing off, check:

- The requested contract is satisfied, with relevant verification evidence.
- The changed code has been assessed against applicable construction guidance; material departures are corrected or justified.
- Warranted review findings are resolved, and remaining limitations or unassessed areas are disclosed.

Use the existing verification and review evidence for these checks; repeat only checks affected by corrections. If a completion condition is unmet, report the specific blocker. The handoff need not print routine checkboxes.

Hand off verification evidence, a brief account of review findings and their disposition, remaining limitations and tradeoffs, and the actual delivery state. Do not treat this workflow as authorization to commit, push, or publish.
