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

## Conditions and validation

- **C3 (Rule)** Give compound boolean conditions (`&&`, `||`), boundary or index
  checks (such as `index < lastIndex` or `value == limit - 1`), and inline
  conditional expressions (`if`/`else`, ternaries) an intention-revealing domain
  name—as a local constant/variable, property, or focused helper—instead of
  embedding them directly inside guards/assertions, branch conditions, lambdas,
  or call arguments, even when the inline expression is short. Leave a single
  self-explanatory check (such as an emptiness check, `value > 0`, or
  `subtotal > threshold`) inline in a standalone guard or as the direct return
  expression of a small named function whose name states the rule.

  ```text
  // Instead of: if (code.length == 8 && allLetters(code.prefix(3))) …
  if (isWellFormedSku(code)) …

  // Instead of: assert(age >= minimumAge && hasConsent)
  isEligible = age >= minimumAge && hasConsent
  assert(isEligible)

  // Instead of an inline conditional inside a branch or call argument:
  //   RETRY -> update(delay = if (attempts >= maxAttempts) maxDelay else delay * 2)
  RETRY -> update(delay = nextBackoffDelay())

  // Instead of: items.map(item -> if (item.active && item.expired) archive(item) else item)
  items.map(archiveIfExpired)
  ```
- **C4 (Default)** Prefer ordinary string operations and explicit checks over
  regular expressions when they express the rule clearly. Use a regular
  expression only when it materially simplifies the code, and give it a
  descriptive name rather than embedding an unnamed regex inline.

## Functions, classes and dependencies

- **C5 (Default)** Choose functions, modules, or classes by responsibility. Use
  a class or module when it gives related behavior and knowledge a coherent
  home, even without mutable state; use standalone functions when no such
  grouping is needed.
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

See [testing.md](testing.md) (`T1`–`T5`) when writing, changing, or reviewing tests, plus [testing-unit.md](testing-unit.md) (`TU1`–`TU2`) for unit tests and [testing-integration.md](testing-integration.md) (`TI1`–`TI3`) for persistence, API/HTTP, or end-to-end tests.
