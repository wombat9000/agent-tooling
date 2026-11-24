# Unit testing

Applies when writing, changing, or reviewing unit tests—fast, in-memory tests
that run without booting a server, database, or browser. Read alongside
[testing.md](testing.md). Language- and framework-independent.

- **TU1 (Rule)** Verify one cohesive behavior, invariant, or failure condition
  per unit test with a single clear Arrange, one Act, and focused Assert phase
  and a focused name. Do not chain unrelated operations, distinct behaviors, or
  compound multi-phase workflows into one unit test method; if a unit test name
  joins distinct behaviors with `"and"` (such as `"X and Y"`), split it so each
  failure pinpoints one rule. A compact table or loop checking related inputs
  for one cohesive rule is fine.
- **TU2 (Rule)** Use real pure domain objects directly rather than mocking them.
  Where a boundary collaborator must be mocked or faked in a unit test, stub
  once and assert observable outcomes or captured arguments once—never duplicate
  the same multi-field argument predicate in both stubbing and verification.
  Avoid strict call-order assertions unless ordering is itself an observable
  contract, avoid broad catch-all wildcards in meaningful verifications, and do
  not write mock-only unit tests for trivial pass-through wrappers.
