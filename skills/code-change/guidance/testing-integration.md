# Service and persistence integration testing

Applies when writing, changing, or reviewing persistence, API/HTTP, or service
integration tests. Read alongside [testing.md](testing.md); for browser or UI
end-to-end tests, see [testing-e2e.md](testing-e2e.md). Language- and
framework-independent.

- **TI1 (Rule)** Give each persistence, API/HTTP, or service integration test a
  cohesive scope: verify either one focused contract check or one coherent
  workflow or lifecycle transition with a clear purpose. Do not build sprawling
  kitchen-sink scripts that chain unrelated endpoints, independent workflows,
  and multiple unrelated error or validation rejections into one mega-test.
  Brief setup calls needed to reach the starting state are fine. Organize larger
  suites into focused files or grouped suites by capability rather than
  appending endlessly to one kitchen-sink file.
- **TI2 (Rule)** Before writing or adding a new integration or API/HTTP test
  file, inspect existing test support and sibling test files and reuse or
  extend the repository's shared domain fixture builders, client or actor
  helpers, and typed response models—never introduce ad-hoc private setup or
  request helpers, copy-pasted entity creation, or hardcoded magic IDs in a
  new sibling test file. Keep high-level API/HTTP integration test method
  bodies completely free of inline raw database queries or mutations (`SELECT`,
  `INSERT`, `UPDATE`, row-count queries, or direct table mutations)—even to
  seed state or verify persisted rows after an HTTP call; only a clean-slate
  reset in a setup or teardown hook belongs there. Verify API outcomes through
  public endpoints and typed responses, and place direct storage assertions,
  schema constraint checks, and transaction-rollback or repository-level
  concurrency checks in dedicated persistence tests.
- **TI3 (Rule)** Exercise real internal application wiring inside persistence,
  API/HTTP, and service integration tests—never mock or spy on internal
  services, domain collaborators, or internal repositories inside a full-stack
  test context (fake or stub only external third-party boundaries such as email
  gateways, payment providers, or external identity providers). Keep tests
  deterministic and isolated via clean state resets and controlled clocks or
  explicit synchronization rather than arbitrary sleeps.
