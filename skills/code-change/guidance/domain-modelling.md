# Domain modelling

Model domain concepts, their valid states, and the operations that preserve their
rules. This file does not prescribe a class hierarchy or file layout; see
`module-design.md` for interfaces and boundaries.

- **D1 (Rule)** Model a domain change as an operation that returns new state
  rather than mutating existing objects or collections. Use a mutable store or
  cache only when a concrete requirement, such as measured performance or an
  external API, makes immutable transitions unsuitable. Needing to track a value
  that changes over time is not, by itself, such a requirement.
- **D2 (Rule)** Give a domain value its own type when it has validity rules or
  behavior, and enforce its intrinsic rules at construction. When validity depends
  on several values together, the domain object that owns their relationship
  enforces it and preserves it through its operations. Parsers construct valid
  domain objects; they are not the only guard of domain validity. Do not add
  wrappers that carry no domain meaning.
- **D3 (Default)** Once a type guarantees a condition, let dependent operations
  rely on it instead of rechecking it or distinguishing cases that behave the same.
  Keep checks for external input and for conditions the invariants do not cover.
- **D4 (Rule)** Parse external input into domain values and operations before
  executing domain behavior. Domain objects and application logic do not
  interpret input tokens, format protocol output, or throw transport-specific
  errors (such as HTTP status exceptions); translate domain outcomes at the
  boundary.
- **D5 (Default)** Express domain actions, questions and relationships as named
  operations on the type that owns the knowledge (`order.isOverdue(today)`),
  rather than reconstructing them from fields or inline conditional calculations
  in callers or branching logic. Leave self-explanatory checks inline.
