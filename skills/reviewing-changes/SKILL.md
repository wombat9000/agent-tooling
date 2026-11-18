---
name: reviewing-changes
description: "Reviews implementation correctness, test quality and design against requirements and construction guidance. Use for code reviews and the review pass in implementing-changes; assessment only, not implementation or workflow orchestration."
---

# Reviewing Changes

Assess the code independently against its requirements, not the implementer's confidence or passing tests. Return findings to the requester without editing implementation, tests or guidance, or starting another reviewer. Follow the supplied task boundaries, including any evaluation restrictions.

Load the accompanying [writing-code](../writing-code/SKILL.md) and read its applicable references. Load [reviewing-design](../reviewing-design/SKILL.md) for the design assessment below. Keep construction principles in those sources rather than inventing a separate review style standard.

## Establish the review scope

Read the requirements, repository instructions, relevant code and tests, and verification evidence. Include new files, not only tracked diffs. Follow affected operations through callers and dependencies to establish their actual behavior. For a change to existing code, distinguish introduced problems from pre-existing ones; for a new implementation, assess the whole requested contract.

If inputs or evidence are missing, identify the limitation rather than filling it with assumptions. Do not consult earlier solutions or reviews when the task excludes them.

## Assess correctness

Trace observable outcomes back to the contract, including boundaries, invalid inputs, failure behavior and state changes. Check regressions in affected callers. Investigate atomicity, concurrency, resource lifetime or security where the operation and requirements make them relevant, not as demands for new features or infrastructure.

For a suspected defect, identify a specific input or execution sequence where required and actual behavior differ. Run permitted non-destructive checks when useful. Distinguish an executed reproduction from a conclusion traced through code and from an unverified hypothesis. Passing the author's tests does not settle correctness.

## Assess test quality

Derive expected results from the requirements independently of the implementation. Identify plausible wrong implementations and check whether the tests distinguish them from the intended behavior, especially on either side of boundaries and after rejected operations. Assess whether assertions check observable results rather than merely successful execution or internal call patterns.

Recommend a test only when it would catch a specific plausible regression that existing checks miss. A missing test is not proof of a production defect. Report gaps in verification separately from confirmed incorrect behavior; do not ask for more tests just to increase their number.

## Assess design

Apply `reviewing-design` to the reviewed code, scaled to its scope. Trace how invariants and caller obligations are maintained across actual interfaces, rather than judging names or declarations alone. Use `writing-code` and its applicable references as the standard, not a preferred layer count, file count or framework architecture.

Report a design problem only with concrete reading, change or safe-usage costs and a smaller justified alternative. Keep defensible tradeoffs and optional preferences distinct from problems that warrant correction.

## Return the assessment

Order findings by consequence. For each finding, give:

- A code location and category: correctness, test gap or design.
- The requirement or guidance involved, evidence and consequence. Label uncertainty and whether a failure was reproduced or inferred from code.
- The smallest justified correction and how to verify it; include the tradeoff for a design change.

Keep optional alternatives separate. State checks performed, limitations and which review areas could not be assessed. If no warranted findings remain, say so without inventing a quota or claiming the implementation is proven correct.

For a targeted re-review, assess the correction and affected behavior, including regressions it could introduce. Do not reopen settled preferences or expand into unrelated work. The implementer owns resolution and final verification; this assessment does not authorize fixes or publication.
