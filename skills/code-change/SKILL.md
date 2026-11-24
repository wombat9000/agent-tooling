---
name: code-change
description: "Implements and reviews code changes in the maintainer's style: readable direct code, domain types that own their invariants, deep modules, and evidence-backed reviews. Use when asked to implement a feature, fix a bug, refactor, or write tests, or to review a diff, branch, pull request, or module design. Not for questions about code or edits to non-code files."
---

# Code change

One style guide, two modes. Implement mode writes code that follows the guide;
review mode assesses code against the same guide. Both modes apply the same
rules, so what one mode writes is what the other expects.

## 1. Choose the mode

| The request | Mode | Read |
|---|---|---|
| Change code: a feature, fix, refactor or tests, including "implement and review" | Implement | [modes/implement.md](modes/implement.md) |
| Review, assess or audit code, a diff, a branch or a pull request, or you were briefed as the reviewer | Review, full scope | [modes/review.md](modes/review.md) |
| Assess only the design, boundaries or interfaces of code | Review, design-only scope | [modes/review.md](modes/review.md) |

Read only the file for the chosen mode.

## 2. Read the style guide

| File | Read when |
|---|---|
| [guidance/code.md](guidance/code.md) | Always |
| [guidance/module-design.md](guidance/module-design.md) | The code adds or changes a function, class or module interface; splits, merges or moves code between files; or the review has design-only scope |
| [guidance/domain-modelling.md](guidance/domain-modelling.md) | The code creates or changes domain values, validation or state transitions |
| [guidance/testing.md](guidance/testing.md) | The change writes, changes, or reviews tests |
| [guidance/testing-unit.md](guidance/testing-unit.md) | The change writes, changes, or reviews unit tests |
| [guidance/testing-integration.md](guidance/testing-integration.md) | The change writes, changes, or reviews persistence, API/HTTP, or end-to-end tests |
| [guidance/kotlin.md](guidance/kotlin.md) | The code is Kotlin |

Each guideline has an ID and a strength:

- **Rule**: follow it when writing code. In review, an unjustified departure is a *Should fix* finding.
- **Default**: the preferred choice when nothing else decides. In review, a departure is at most an *Optional* finding.

Cite guidelines by ID (for example `M3`) in plans, handoffs and findings.

## 3. Resolve conflicts by precedence

1. The user's instructions for this task.
2. Repository instructions: `AGENTS.md`, `CLAUDE.md`, contributing guides, and configured linters and formatters.
3. Patterns that the surrounding code follows consistently.
4. Rules in this guide.
5. Defaults in this guide.

When a higher level overrides a Rule, follow the higher level and mention the
departure in the handoff or report. Do not refactor existing code to match this
guide unless asked: consistency within a codebase is worth more than this guide's
preferences. In review, code that follows a higher level is not a finding.

## Terms

- **Requirements**: the observable outcome the task asks for, including compatibility constraints and how success is checked.
- **Evidence** for a claim is one of: **reproduced** (a command or test demonstrated it), **traced** (followed through the code with file and line references), or **hypothesis** (plausible but not confirmed).

## Authority

Neither mode authorizes committing, pushing, publishing, or adding dependencies.
Do those only when the user asks.
