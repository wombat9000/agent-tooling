# Integration and end-to-end testing

Applies when writing, changing, or reviewing persistence, API/HTTP, or
end-to-end tests. Read alongside [testing.md](testing.md). Language- and
framework-independent.

- **TI1 (Rule)** Give each integration, persistence, API/HTTP, or end-to-end
  test a cohesive scope: verify either one focused contract check or one
  coherent user journey or lifecycle transition with a clear purpose. Do not
  build sprawling kitchen-sink scripts that chain unrelated endpoints,
  independent workflows, and multiple unrelated error or validation rejections
  into one mega-test. Brief setup calls needed to reach the starting state are
  fine. Organize larger suites into focused files or grouped suites by
  capability rather than appending endlessly to one kitchen-sink file.
- **TI2 (Rule)** Reuse or extend shared domain fixture builders and client or
  actor helpers so integration test bodies stay concise and skimmable—never
  copy-paste private entity-creation helpers or hardcoded magic IDs across
  sibling test files. Keep high-level API/HTTP and end-to-end test method bodies
  completely free of inline raw database queries or mutations (`SELECT`,
  `INSERT`, `UPDATE`, row-count queries, or direct table mutations); only a
  clean-slate reset in a setup or teardown hook belongs there. Put direct
  database assertions, schema constraint checks, and transaction or concurrency
  checks in dedicated persistence tests.
- **TI3 (Rule)** Exercise real internal application wiring inside integration,
  persistence, API/HTTP, and end-to-end tests—never mock or spy on internal
  services, domain collaborators, or internal repositories inside a full-stack
  test context (fake or stub only external third-party boundaries such as email
  gateways, payment providers, or external identity providers). Keep tests
  deterministic and isolated via clean state resets and controlled clocks or
  explicit synchronization rather than arbitrary sleeps.
