# Testing

Write tests that protect real behavior at the right layer and stay skimmable as
the codebase grows. Apply these rules at the scale of the system: a small
pure-logic library needs only fast unit tests at its public boundary, whereas a
layered service separates fast unit tests, persistence tests, and thin
end-to-end slices. Language- and framework-independent.

## Requirements and layering

- **T1 (Rule)** Derive expected values independently from the requirements, not
  from running the implementation or calling the production helper under test.
  Cover meaningful boundaries, invariants, and failure modes with genuine
  failure conditions—not tautological self-comparisons or assertion-free probes
  that only confirm code ran without throwing.
- **T2 (Rule)** Give every invariant one authoritative test layer at the lowest
  execution tier that genuinely enforces it:
  - **Fast unit test file(s) (no server, database, or browser):** whenever
    production code contains substantial pure domain logic, policy rules, state
    transitions, or input parsing/validation alongside an application or
    infrastructure boundary, write dedicated fast unit tests covering that logic
    and its edge-case matrix directly. Never rely solely on heavyweight
    integration tests for pure logic, and never place unit-level tests or direct
    internal-service calls inside a heavyweight HTTP/E2E test class.
  - **Dedicated persistence/storage tests:** queries, schema constraints,
    database-backed state visibility, transactions, locking, and concurrency.
  - **High-level API or end-to-end tests:** thin vertical slices through the
    public boundary verifying wiring, serialization, authentication or
    authorization boundaries, and key cross-component happy and failure paths.

  Do not echo the same exhaustive validation or state-transition matrix across
  multiple layers.

## Structure and readability

- **T3 (Rule)** Verify one cohesive behavior, invariant, or failure condition
  per test with a single Arrange, one Act, and focused Assert phase and a
  focused name. Do not chain multiple independent operations, lifecycle
  transitions, endpoints, or unrelated error cases into one test method (for
  example, testing creation, conflict, cancellation, duplicate cancellation, and
  re-creation—or mixing malformed input, policy rejections, and unknown-resource
  errors—in a single test). If a test name joins distinct behaviors with `"and"`
  (such as `"X and Y"`), split it into separate tests so each failure pinpoints
  one rule. Brief setup calls to reach the state under test, or a compact
  table/loop checking related inputs for one rule, are fine. Organize larger
  suites into focused files or grouped suites by capability rather than
  appending endlessly to a single kitchen-sink file.
- **T4 (Rule)** Assert meaningful observable contract outcomes—returned values
  and key contract fields (not merely HTTP status codes, a single status field,
  or collection lengths), observable state, specific error types or codes where
  defined, and state preservation after rejected mutations. For structured API
  or JSON responses, deserialize into typed response models (a production
  response type or small test model) or use concise structured response
  matchers—do not repeatedly parse responses through raw untyped JSON/tree node
  lookups (even behind a helper returning a raw tree node). Identify items in
  multi-item collections by stable key or match the full expected collection
  instead of brittle hardcoded array positions. Use direct diagnostic assertions
  (equality, type checks) rather than lossy boolean-wrapped expressions
  (`assert(a == b) == true`) or coupling to exact internal exception-message
  prose.

## Fixtures, boundaries, and test doubles

- **T5 (Rule)** Reuse or extend shared domain fixture builders and client/actor
  helpers so test bodies stay concise and skimmable—do not copy-paste private
  setup helpers or hardcoded magic IDs across sibling test files. Keep
  high-level API or end-to-end test methods completely free of inline raw
  database queries (`SELECT`, `INSERT`, `UPDATE`, row counts, or direct table
  mutations)—even for a single assertion; only a clean-slate reset in a
  before/after setup hook belongs there. Establish preconditions and verify
  outcomes through public boundaries or shared fixture helpers, and put direct
  database assertions or mutations in dedicated persistence tests.
- **T6 (Rule)** Test through real public or module boundaries so internal
  reorganization does not require rewriting tests; do not introduce test-only
  production seams or widen visibility solely to reach private helpers (`M12`).
  Prefer real pure domain objects over mocks. When mocking a boundary
  collaborator, stub once and assert observable outcomes or captured arguments
  once—never duplicate the same multi-field argument predicate in both stubbing
  and verification. Avoid strict call-order assertions unless ordering is itself
  an observable contract, avoid broad catch-all wildcards in meaningful
  verifications, and do not write mock-only unit tests for trivial pass-through
  wrappers.
- **T7 (Default)** Consolidate three or more near-identical test cases that vary
  only by input and expected outcome into parameterized or table-driven tests
  rather than copy-pasting test methods. Add a test only when it would fail for
  a specific, plausible wrong implementation that existing tests would not
  catch—not merely to increase test count.
