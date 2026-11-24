# Testing

Core testing guidance. Write tests that protect real behavior at the right layer
and stay skimmable as the codebase grows. Apply these rules at the scale of the
system: a small pure-logic library needs only fast unit tests at its public
boundary, whereas a layered service separates fast unit test file(s),
persistence tests, and thin end-to-end slices. Read whenever writing, changing,
or reviewing tests; pair with [testing-unit.md](testing-unit.md) for unit tests
and [testing-integration.md](testing-integration.md) for persistence, API/HTTP,
or end-to-end tests. Language- and framework-independent.

- **T1 (Rule)** Derive expected outcomes independently from the requirements,
  not by calling the production logic under test or running the implementation
  to record its output. Cover the core required behaviors, boundaries,
  invariants, and failure or rejection modes with genuine failure-detecting
  assertions—not tautological self-comparisons or assertion-free probes that
  only check a call ran without throwing or returned non-null.
- **T2 (Rule)** Give every invariant one authoritative test layer at the lowest
  execution tier that genuinely enforces it:
  - **Fast unit test file(s) (no server, database, or browser):** whenever
    production code contains substantial pure domain logic, policy rules, state
    transitions, or input parsing/validation alongside an application or
    infrastructure boundary, write dedicated fast unit test file(s) covering
    that logic and its edge-case matrix directly. Never rely solely on
    heavyweight integration tests for pure logic, and never place unit-level
    tests, direct internal-service calls, or raw database constraint checks
    inside a heavyweight API or end-to-end test class.
  - **Fast transport slice tests (where supported):** request binding,
    serialization, and transport error mapping.
  - **Dedicated persistence tests:** queries, schema constraints,
    database-backed state visibility, transactions, locking, and concurrency.
  - **Thin vertical slices in API/HTTP or end-to-end tests:** public-boundary
    wiring, authentication/authorization boundaries, and key cross-component
    happy and failure paths.

  Do not echo the same exhaustive validation or state-transition matrix across
  multiple layers; a thin representative slice at a higher layer is enough when
  unit tests own the full matrix.
- **T3 (Rule)** Assert meaningful observable contract outcomes—returned values
  and key contract fields (not merely status codes, a single status field, or
  collection lengths), observable state, specific error types or codes where
  defined, and state preservation after rejected mutations. For structured API
  or JSON responses, deserialize into typed response models (a production
  response type or small test model) or use concise structured response
  matchers—never repeatedly parse responses through raw untyped tree or node
  lookups (even behind a helper returning a raw tree node). Identify items in
  multi-item collections by stable key or match the full expected collection
  rather than brittle hardcoded array positions. Use direct diagnostic
  assertions (equality, type checks) rather than lossy boolean wrappers
  (`assert(a == b) == true`) or coupling to exact internal exception prose.
- **T4 (Rule)** Test through real public or module boundaries so internal
  reorganization does not require rewriting tests; do not introduce test-only
  production seams, test-only flags, or widened visibility solely to reach
  private helpers (`M12`).
- **T5 (Default)** Consolidate three or more near-identical input/outcome cases
  into parameterized or table-driven tests (or shared helpers) rather than
  copy-pasting test methods. Add a test only when it would fail for a plausible
  wrong implementation that existing tests would miss—not merely to raise test
  count.
