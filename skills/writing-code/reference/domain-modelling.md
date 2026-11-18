# Domain Modelling

Model domain concepts, valid states, and the operations that preserve their rules.
Read this reference when modelling or reviewing domain values, invariants, or
state transitions. Use module design for interfaces, information hiding, and
file organization; this reference does not prescribe a class hierarchy or layout.

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
- Use established domain invariants to simplify decisions. Once the owning type
  guarantees a condition, let dependent operations rely on it rather than repeat
  checks or distinguish cases that have the same behavior. Keep checks for external
  input and conditions those invariants do not guarantee.
- Parse external input into domain values and operations before executing domain
  behavior. Domain objects should not interpret input tokens or format protocol
  output.
- Express domain actions, questions, and relationships as named operations on the
  type that owns the relevant knowledge. Prefer these over making callers reconstruct
  their meaning from fields or calculations. Leave self-explanatory checks inline.
