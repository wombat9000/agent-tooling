# Browser and UI end-to-end testing

Applies when writing, changing, or reviewing browser or UI end-to-end tests.
Read alongside [testing.md](testing.md). Language- and framework-independent.

- **TE1 (Rule)** Use user-visible, resilient locators: locate and assert UI
  elements by accessible roles, labels, headings, or visible text (using
  dedicated test IDs only when no accessible role or label exists)—never by
  brittle CSS class chains, DOM hierarchy paths, or hardcoded `nth-child` /
  element indexes.
- **TE2 (Rule)** Rely on deterministic web-first waiting and clean state
  isolation: use auto-waiting observable UI assertions rather than arbitrary
  fixed sleeps or manual timeouts, and start each test from isolated, known
  state (resetting or seeding state cleanly instead of depending on prior tests
  or clicking through unrelated setup flows).
- **TE3 (Rule)** Focus browser end-to-end tests on critical user-visible
  journeys (rendering, interaction, routing, and persistence across reloads)
  with one coherent journey per test—never sprawling multi-feature kitchen-sink
  scripts chaining unrelated workflows and rejections. Do not push exhaustive
  pure client-side logic matrices into slow browser tests when fast unit tests
  fit better.
