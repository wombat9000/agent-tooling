# Domain modelling

Model domain concepts, their valid states, and the operations that preserve their
rules. This file does not prescribe a class hierarchy or file layout; see
`module-design.md` for interfaces and boundaries.

- **D1 (Rule)** Model a domain change as an operation that returns new state
  rather than mutating existing objects or collections. Use a mutable store or
  cache only when a concrete requirement, such as measured performance or an
  external API, makes immutable transitions unsuitable. Needing to track a value
  that changes over time is not, by itself, such a requirement.
- **D2 (Rule)** Model closed domain concepts with a finite set of states, tiers,
  categories, decisions, or modes as dedicated enums or discriminated unions
  rather than raw strings, booleans, or magic numbers in core logic. Give any
  domain value or entity with validity rules, units, or behavior its own type—or
  a validated constructor or factory function in languages with plain structural
  records—and enforce its intrinsic invariants at construction (including when
  reconstituting stored data). When validity depends on several values together,
  the domain type or module that owns their relationship enforces it and
  preserves it through its operations. Parsers and UI handlers call those
  constructors or factories to produce valid domain values rather than
  validating separately while constructing raw values inline. When a factory or
  domain operation returns failure as a value rather than throwing, return a
  tagged/discriminated result rather than an untagged union that forces callers
  to branch on runtime types (`typeof`/`instanceof`). Do not add single-field
  wrappers that carry no domain rules, distinct units, or behavior.
- **D3 (Default)** Once a type guarantees a condition, let dependent operations
  rely on it instead of rechecking it or distinguishing cases that behave the same.
  Keep checks for external input and for conditions the invariants do not cover.
- **D4 (Rule)** Parse external input into domain values and operations before
  executing domain behavior. Domain objects and application logic do not
  interpret input tokens, format protocol output, throw transport-specific
  errors (such as HTTP status exceptions), perform storage I/O directly, or read
  ambient system state (such as the system clock, random/ID generators, or
  environment) directly; supply such inputs as values or injected collaborators
  from the entry point or boundary, keep persistence in a dedicated storage
  module, and translate domain outcomes at the boundary.
- **D5 (Rule)** Put domain actions, invariant checks, state transitions, and
  variant-specific rules on the owning domain type, enum/union, or domain module
  rather than scattering them across callers or services:
  - Express domain operations, predicates, and transitions as named operations on
    the type or module that owns the data (`order.isOverdue(today)`,
    `order.cancel(now)`, or `isOverdue(order, today)`) rather than pulling fields
    out of passive data records in a service or handler to compute policies or
    assemble updated copies externally. Leave self-explanatory single checks
    inline.
  - When multiple rules, metadata, or state transitions depend on the same closed
    status, tier, decision, or mode, attach those properties or operations to the
    owning enum, union, or variant definition—or one authoritative exhaustive
    mapping—instead of repeating `if`/`switch` branches on the same discriminator
    across functions or branches. Do not introduce speculative interfaces for a
    fixed set of variants (`C7`).
