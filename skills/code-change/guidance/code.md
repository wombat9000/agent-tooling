# Code

Applies to all code. **Rule**: follow; an unjustified departure is a Should fix
finding. **Default**: preferred; a departure is at most Optional.

## Readability and names

- **C1 (Rule)** Write readable, direct code rather than clever code. Make domain
  relationships and state transitions explicit (for example, with an exhaustive
  `when`/`switch` or direct mapping) instead of deriving them from enum order,
  array positions, or arithmetic tricks, even when the explicit form is longer.
  Code is read far more often than it is written.
- **C2 (Rule)** Name things with terms from the problem domain, so that a value's
  meaning is clear without tracing where it came from.

## Validation

- **C3 (Default)** Give a non-obvious validation rule a name that says what makes
  the input valid, and use that name at the point of use instead of an embedded
  pattern or compound expression. Leave self-explanatory checks inline.

  ```kotlin
  // Instead of: if (code.length == 8 && code.take(3).all(Char::isLetter)) …
  if (isWellFormedSku(code)) …
  ```
- **C4 (Default)** Prefer ordinary string operations and explicit checks over
  regular expressions when they express the rule clearly. Use a regular
  expression only when it materially simplifies the code, and give it a
  descriptive name rather than embedding an unnamed regex inline.

## Functions, classes and dependencies

- **C5 (Default)** Choose functions or classes by responsibility. Use a class when
  it gives related behavior and knowledge a coherent home, even without mutable
  state; use standalone functions when no such grouping is needed.
- **C6 (Default)** Extract a small function when it expresses a coherent domain
  operation, not merely to reduce line count.
- **C7 (Rule)** Add an interface, framework or abstraction layer only for a need
  that exists now, not for hypothetical future variation. Each extra concept costs
  every future reader.
- **C8 (Default)** Prefer the standard library over new dependencies or custom
  utilities.

## Documentation

- **C9 (Rule)** Document an operation's contract where its name and types do not
  make it clear: what the inputs mean, what it changes or returns, and relevant
  boundaries, ordering and failure behavior. Readers should be able to use it
  without reading its implementation. Put shared conventions on the type that owns
  them rather than repeating them at each use. Omit self-evident details, explain
  non-obvious rationale, and keep comments current.

## Tests

- **T1 (Rule)** Derive expected values from the requirements, not from running the
  implementation. Expected values copied from the output only confirm what the
  code already does.
- **T2 (Rule)** Assert observable results, such as returned values, persisted
  state or emitted output, rather than only that the code ran or which internal
  calls it made.
- **T3 (Rule)** Test through the module's interface so that internal
  reorganization does not require rewriting assertions. Do not widen visibility to
  test private helpers.
- **T4 (Rule)** Add a test when it would fail for a specific, plausible wrong
  implementation that the existing tests would not catch. Do not add tests only to
  increase their number.
