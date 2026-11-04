---
name: writing-code
description: "Guides readable, direct code, with references for Kotlin conventions and module interfaces, responsibility boundaries, and information hiding. Use when writing or reviewing code, including Kotlin work and module-design decisions."
---

# Writing Code

Apply shared construction principles when writing or reviewing code. This skill
owns code guidance, not implementation, review, or evaluation workflows.

## Read the applicable references

- For Kotlin code, read [Kotlin conventions](reference/kotlin.md) before writing
  or reviewing it.
- When choosing or reviewing responsibility boundaries, interfaces, or file
  organization, read [module design](reference/module-design.md).
- Read only the references relevant to the task; do not load every reference by
  default. These documents apply the shared principles to a language or design
  concern; they are not separate skills or additional workflows.

## Readability and names

- Prefer readable, direct code over cleverness. Favor explicit domain relationships
  over calculations that require the reader to infer them, even when the explicit
  form is longer. Use names from the problem domain.
- Prefer names that make a value's meaning clear without requiring the reader to
  trace its origin.

## Values and domain operations

- Model domain changes as operations that return new state rather than mutate
  existing objects or collections. Use mutable stores or caches only when a
  concrete requirement makes immutable transitions unsuitable; needing to track
  changing values is not sufficient justification.
- Represent domain values with their own types when they have meaningful validity
  rules or behavior. Enforce intrinsic rules at construction. When validity depends
  on several values together, let the domain object that owns their relationship
  enforce those rules and preserve them through its operations. Parsers should
  construct valid domain objects, not be the sole guardians of domain validity.
  Avoid wrappers that add no domain meaning.
- Parse external input into domain values and operations before executing domain
  behavior. Domain objects should not interpret input tokens or format protocol
  output.
- Express domain actions, questions, and relationships as named operations on the
  type that owns the relevant knowledge. Prefer these over making callers reconstruct
  their meaning from fields or calculations. Leave self-explanatory checks inline.

## Validation

- Give validation rules meaningful names that express what makes the input valid.
  At the point of use, prefer a named rule over an embedded pattern or compound
  expression. Leave self-explanatory checks inline.
- Prefer ordinary string operations and explicit checks over regular expressions
  when they express the rule clearly. Use regex only when it materially simplifies
  the code, and give it a descriptive name.

## Functions and contracts

- Choose functions or classes by responsibility and encapsulation. Use a class
  when it gives related behavior and knowledge a coherent home, even without
  mutable state; use standalone functions when no such grouping is needed.
- Use small functions when they express a coherent domain operation, not merely to
  reduce line count. Avoid interfaces, frameworks, and abstraction layers without a real need.
- Prefer the standard library.
- Document operations so readers can use them without tracing their implementation.
  Where names and types are insufficient, describe the contract: what inputs mean,
  what changes or is returned, and relevant boundaries, ordering, and failure
  behavior. Put shared conventions on the type that owns them rather than repeating
  them at each use. Omit self-evident details; explain non-obvious rationale
  separately, and keep comments current.
