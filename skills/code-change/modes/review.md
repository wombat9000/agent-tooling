# Review mode

Assess code against its requirements and the style guide, and return findings.
Do not edit files or start another reviewer. The implementer resolves findings.

Judge the code, not the author's confidence or the fact that tests pass.

## 1. Gather the inputs

Collect the requirements, repository instructions, recorded design decisions
(such as ADRs), verification evidence, and the
changed files, including new untracked files (`git status`, `git diff <base>`).
Read the current contents of each changed file, not only the diff: the diff
alone omits the context that decides most findings. Read the style guide files
that apply (see the table in `SKILL.md`).

When an input is missing, list it under *Not assessed* rather than assuming it.

For a change to existing code, assess what the change introduced. List problems
that already existed separately under *Pre-existing*. For new code, assess all
of it.

## 2. Assess correctness (full scope)

For each requirement, trace the code that delivers it. Check boundaries, invalid
input, failure paths and state changes, and follow the change into its callers
to catch regressions. Examine concurrency, resource lifetime and security when
the changed code touches them.

For a suspected defect, name a concrete input or sequence of calls where the
required and actual behavior differ.

## 3. Assess tests (full scope)

Derive the expected results from the requirements. Name plausible wrong
implementations, such as an off-by-one at a boundary or state left modified
after a rejected operation, and check whether the tests would fail for them.
Check the tests against `T1`–`T4`.

A test gap is a finding only for in-scope behavior where a named wrong
implementation would pass. A missing test is not evidence of a defect.

## 4. Assess style and design

Complete this scan for every changed file even when sections 2 and 3 already
produced findings. An unjustified departure from a **Rule** is a *Should fix*
finding even when the code is short and tests pass. Do not invent findings when
a check passes.

Check each applicable Rule group in the guide files you read:

- [ ] Readability, names, and inline conditions (`C1`–`C3`, `C7`, `C9`) —
  including compound (`&&`/`||`) or non-obvious checks inside `require`/`if`/`when`
  and input/boundary validation.
- [ ] Domain invariants and immutability (`D1`, `D2`; in Kotlin `K2`, `K3`).
- [ ] Boundaries, layering, and information hiding (`D4`, `M1`–`M3`, `M5`–`M8`, `M10`).
- [ ] File layout and visibility (`M11`, `M12`).

Check relevant Defaults as well. For design, use the review questions and the
three-part test in `guidance/module-design.md`. With design-only scope, skip
sections 2 and 3, and list in the report the operations and boundaries you
inspected.

## 5. Challenge each finding

Before reporting a finding, try to disprove it: reread the code, and check its
callers, guards, configuration and tests. Run a reproduction when it is safe and
permitted. Drop findings you cannot support with a file and line reference.

Assign severity:

| Severity | Use for |
|---|---|
| **Blocking** | A requirement is not met, behavior is incorrect, or the change causes a regression, a security problem or data loss. Requires reproduced or traced evidence. |
| **Should fix** | An unjustified departure from a Rule with a named consequence; a test gap as defined in section 3; a design problem that passes the three-part test; a suspected defect with hypothesis evidence. |
| **Optional** | A departure from a Default; a design alternative that does not pass the three-part test; anything else worth mentioning but not required. |

## 6. Report

Use this format. List findings by severity, most severe first.

```text
Verdict: ready | ready after fixes | needs rework

### <Severity> — <short title>
- Location: <path:line>
- Category: correctness | test gap | style | design · <guideline ID, if any>
- Evidence: reproduced | traced | hypothesis — <details>
- Consequence: <what goes wrong, for whom>
- Fix: <smallest correction>; verify by <check>
- Tradeoff: <cost of the fix, for design findings>

Pre-existing: <one line each, or "none">
Checks run: <command → result, files traced, and Rule groups audited>
Not assessed: <areas and why, or "none">
```

No findings is a normal result. In that case write `Verdict: ready`, state what
you checked, and do not invent findings to fill the report.

### Example finding

```text
### Should fix — Fee rounding duplicated in callers
- Location: src/billing/Invoice.kt:42, src/billing/Refund.kt:17
- Category: design · M3
- Evidence: traced — both callers compute amount * rate and round half-up
  before calling Ledger.post; Ledger.post accepts any amount.
- Consequence: a rounding change must be made in two places, and a new caller
  can post an unrounded amount.
- Fix: add Fee.of(amount, rate), which owns calculation and rounding, and pass a
  Fee to Ledger.post; verify with the existing InvoiceTest and RefundTest plus
  one test for rounding at 0.005.
- Tradeoff: one new type.
```

## Re-review

When asked to re-review fixes, assess only the fixes and the regressions they
could cause. Do not add findings about unchanged code or reopen findings the
implementer declined with a reason.
