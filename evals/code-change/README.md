# code-change evals

Measures whether the [code-change](../../skills/code-change/SKILL.md) skill improves an agent's
code reviews and greenfield implementations. The tasks are plain folders: a fixture or starter
repository, an instruction, and a deterministic verifier. They depend on no harness.
[Harbor](https://github.com/harbor-framework/harbor) runs them.

Codex is the default harness. An experimental [Amp harness](#amp-in-harbor) is also available.

## Quick start

From the repository root, use `pnpm eval`. Node.js 22.18+ is required. There are no runtime
packages to install. Docker and Harbor (`uv tool install harbor`) are needed for container runs.

```bash
pnpm eval check             # All offline tests
pnpm eval smoke             # Docker: oracle must score 1, nop must score 0
pnpm eval canary            # One Codex trial with the skill
pnpm eval run               # All tasks with the skill: 5 attempts each, 2 concurrent
pnpm eval run --baseline    # Same settings without the skill
pnpm eval run --task refactor-gilded-rose --with-judge-code           # Opt-in: mount skills/judge-code + forward OPENROUTER_API_KEY
pnpm eval run --task refactor-gilded-rose --baseline --with-judge-code # Opt-in: test judge-code alone without code-change
```

Codex defaults to `openai/gpt-6.1-terra`, Fast service (`priority`), high reasoning effort,
and your local login file. Log in with `codex login`
first. An existing `CODEX_AUTH_JSON_PATH` is respected; otherwise the file is found under
`CODEX_HOME` or `~/.codex`. To use API credentials, pass `--auth api`.

Artifacts are exported automatically. Harbor runs are stored under `eval-results/harbor/`.
Score the latest completed Codex run after setting `OPENROUTER_API_KEY` in your shell:

```bash
pnpm eval judge --latest                                      # All tasks and attempts, d1 Ultra
pnpm eval judge review-seeded-bug --latest                    # Only this task's attempts
pnpm eval judge implement-mars-rover --latest --scope per-file # Score each production Kotlin file separately
pnpm eval judge implement-meeting-room-booking --latest --target tests # Score exported test suites against task tests/judge-tests.json facets
pnpm eval judge --latest --judge jev                          # Same reports, Jev
pnpm eval judge --resume eval-results/judges/<run>/<batch>    # Resume an interrupted batch, skipping already-scored trials
```

Each judge run creates a standalone `report.html` with a Check × Trial matrix (sorted worst-first,
with hoverable rubric criteria and trial/file breakdowns), task KPI summaries, failure-first check
tables, P(pass), confidence, and the original review or tabbed production source. Kotlin and TypeScript files (including TSX) are syntax-highlighted.
Terminal output points to the page instead of listing every trial score. Add `--open` to open the
report after judging.

To view scores you already have, without another API call:

```bash
pnpm eval report --latest --open
```

`pnpm eval report DIRECTORY` builds a page from a particular judge output directory.
`--out FILE.html` writes it elsewhere. The page has task/result filters and expandable trials;
all content is embedded, so the HTML works offline. Scores and rubric text come from the saved
request/result files, not the task rubric as it exists today.

### Eval scorecard and offline dashboard

Checked-in per-task scorecards live under `evals/scorecards/<skill>/<task>.json` and drive both the GitHub-previewable [evals/SCORECARD.md](../SCORECARD.md) and a self-contained interactive offline HTML dashboard (`eval-results/scorecard.html`):

```bash
pnpm eval scorecard --open                                      # Build & open interactive HTML dashboard (leaves tracked Git files untouched)
pnpm eval scorecard build                                       # Regenerate evals/SCORECARD.md and eval-results/scorecard.html
pnpm eval scorecard record <judge-dir...> [--condition skill|baseline] [--git-ref REF] [--agent-model ID] [--open]
```

Freshness is computed from deterministic SHA-256 content hashes (`skill_hash`, `task_hash`, and resolved `rubric_hash`) against the current working tree. Skill entries are **Current** only when all three match; baseline entries check `task_hash` and `rubric_hash` only, so editing a skill does not falsely mark baseline runs stale. Passing `--git-ref <commit>` computes content hashes from that historical commit so archived runs preserve accurate provenance. `pnpm eval check` validates all checked-in scorecard JSON schemas without failing on informational staleness.

No artifact paths are needed for saved runs. The latest run is selected by its completion time;
unfinished runs and oracle/nop jobs are excluded. Use `--run DIRECTORY` to choose a specific
saved Harbor run. To score one review file or an exported production source directory manually, use
`pnpm eval judge TASK PATH`. Pass `src/main/kotlin` for Kotlin or `src` for the TypeScript app.

Judge runs get a unique directory under `eval-results/judges/`. Batch runs contain one
directory per trial and a `summary.json` with the source run and each trial's status and score.
Every selected artifact is checked before API calls begin. Missing artifacts cause an error;
they are not silently skipped. Transient OpenRouter HTTP errors (`429`, `502`, `503`, `504`)
retry automatically up to 4 times with bounded exponential backoff and jitter (honoring
`Retry-After` when present), while non-retryable errors (`400`, `401`, `403`, `404`, network
timeouts, refusals, or malformed responses) fail immediately. If a trial still fails after
retries, judging stops, leaves later trials marked `pending`, retains earlier results, and
prints a `pnpm eval judge --resume <judge-dir>` command to continue in-place. Resuming loads
the saved `summary.json`, keeps all already-`scored` trials untouched, re-runs only `error`
and `pending` trials with the original run, model, target, and scope settings, and regenerates
`summary.json` and `report.html`. `eval-results/` and Harbor's
older `jobs/` directory are ignored by Git; existing results are retained. By default, OpenRouter
keys are used only for host-side judging and are never passed to Harbor containers. Pass the opt-in
`--with-judge-code` flag to `pnpm eval run` or `pnpm eval canary` (with `OPENROUTER_API_KEY` set on
the host) to mount `skills/judge-code` into the container, forward `OPENROUTER_API_KEY` into the
agent runtime environment (via Harbor's `--ae OPENROUTER_API_KEY=${OPENROUTER_API_KEY}` template so
the raw secret is never written to CLI args or `config.json`), and append a required quality-gate instruction requiring the agent's production code to pass both
per-file and `module` `judge-code --fail-on-warning` checks with exit code 0 while keeping
typecheck and tests green.
`--with-judge-code` combines cleanly with both the default `code-change` skill condition and
`--baseline` (to evaluate `judge-code` standalone), and condition metadata is recorded in judge
summaries, HTML reports, and scorecards.

Use `--model ID` or `EVAL_MODEL` to change the Codex model. Use `--effort LEVEL` and
`--service-tier TIER` to override the reasoning effort and service tier. These defaults apply
equally to skill and baseline runs. Use `--judge MODEL_ID` for another
OpenRouter judge, and `--scope whole|per-file` to control whether `production_code` tasks are
judged across all production files at once (default `whole`) or one file per request (`per-file`).
`--task NAME`, `--attempts N`, and `--concurrency N` can narrow or tune a full run (`run` defaults
to `2` concurrent trials). Add `--dry-run` to preview Harbor commands without starting them,
acquiring the Harbor lock, or checking Docker. For judging, `--dry-run` saves the request without
making an API call. `pnpm eval --help` lists all options.

### Host-wide Harbor lock and busy-Docker guard

Container-running commands (`smoke`, `canary`, and `run`, skipped on `--dry-run`) serialize across
worktrees and agents via a user-wide lock file at
`${XDG_CACHE_HOME:-~/.cache}/agent-tooling-evals/harbor.lock` (override with `EVAL_LOCK_PATH`).
The lock records the active PID, command, task, working directory, and start timestamp. If another
live process holds the lock, `pnpm eval` logs the holder and waits until it finishes; pass
`--no-wait` to fail immediately instead. Stale locks from exited processes are reclaimed
automatically, and locks are released on normal exit, errors, `SIGINT`, and `SIGTERM`.

Before starting `pnpm eval run` (skipped on `--dry-run`), the CLI checks running containers via
`docker ps -q` (ignoring failures if `docker` is unavailable). If other containers are already
running and `--concurrency` was omitted, it warns and steps concurrency down from `2` to `1` to
avoid thrashing a local Docker VM alongside other workloads. If `--concurrency N` was explicitly
passed, it keeps `N` and still prints a short warning.

## Tasks

| Task | Kind | What a good run does |
|---|---|---|
| `canary` | Review | Uses the skill's report format and cites a guideline ID. Passes only if the skill loaded; run it first. |
| `review-seeded-bug` | Review | Reports the `>=` threshold bug as **Blocking** correctness at `PricingPolicy.kt:18`. |
| `implement-mars-rover` | Implementation | Implements `rover.MarsRover.execute(inputFile: Path): String` in Kotlin, passes its own and hidden black-box JUnit 5 contract tests, and keeps production code clean and modular. |
| `implement-meeting-room-booking` | Implementation | Builds a Kotlin Spring Boot API from a Gradle-only starter, using JDBC and in-memory H2 for booking, rescheduling, cancellation, and listing. Hidden tests check HTTP behavior, persisted rows, and concurrent conflicts. |
| `extend-invoice-disputes` | Implementation | Extends an existing working Kotlin Spring Boot + JDBC + H2 invoice billing service with an invoice dispute workflow, validation matrix, 30-day cutoff, outbound notifications, and concurrent open/resolve conflict protection. |
| `implement-react-router-todo` | Implementation | Builds a TypeScript React Router todo app with pnpm, route-based filters, and browser-local persistence. Hidden Playwright tests exercise the production build. |
| `refactor-gilded-rose` | Refactoring | Refactors legacy TypeScript Gilded Rose inventory code, adds `Conjured` item support while preserving public `Item` / `GildedRose` API compatibility, and adds unit tests under `tests/`. |

Review tasks ask the agent to write `/output/REVIEW.md` and grade report structure and finding
labels deterministically. Implementation tasks export `/workspace/src` and check the build,
agent tests, and hidden contract tests inside the container. The Kotlin tasks use Gradle. The
todo task uses pnpm and Playwright. In both cases, an optional
host-side judge uses OpenRouter to assess qualitative criteria after the trial.

## Layout

```
cli.mts                    terminal shortcuts used by pnpm eval
cli.test.mts               offline tests of defaults, auth, locks, Docker concurrency, and child commands
lib/docker_concurrency.mts default concurrency policy and busy-Docker host guard for `pnpm eval run`
lib/grade_review.mts       shared review grader: REVIEW.md + expected.json → /logs/verifier/reward.json
lib/harbor_lock.mts        host-wide Harbor lock with owner metadata, stale-PID reclamation, and signal cleanup
lib/sync.sh                stages lib/grade_review.mts into review tasks' tests/ for direct harbor runs (gitignored; pnpm eval does this automatically)
lib/selfcheck.mts          checks review tasks without Docker: reference solution scores 1, no report 0
lib/judge_review.mts       scores a saved review with an OpenRouter decision model (plus shared rubric/API helpers)
lib/judge_review.test.mts  offline tests of review judge requests, responses, and failure handling
lib/judge_code.mts         scores exported production source code (whole or per-file) with an OpenRouter decision model
lib/judge_code.test.mts    offline tests of code judging, per-file aggregation, and failure handling
lib/highlight_kotlin.mts   zero-dependency build-time Kotlin syntax highlighting
lib/highlight_typescript.mts  zero-dependency build-time TypeScript and TSX syntax highlighting
lib/run_condition.mts      shared run-condition metadata detection and opt-in judge-code prompt helper
lib/trial_metrics.mts      Harbor trial token usage, cost, and wall-clock duration extraction, aggregation, and formatting
lib/amp_agent.py           experimental Amp-in-Harbor adapter (with opt-in with_judge_code support and stream-json usage parsing)
lib/amp_agent_test.py      offline Python unit tests for AmpAgent key isolation, judge-code opt-in, and stream-json usage parsing
lib/html_report.mts        standalone HTML report from saved rubric questions, judge scores, and artifacts
lib/scorecard_schema.mts   per-task scorecard JSON schema, canonical serialization, and strict validation
lib/scorecard_hashes.mts   working-tree and git-ref content hashing (skill/task/rubric) and staleness rules
lib/scorecard_discovery.mts repo skill/eval coverage discovery and live scorecard staleness evaluation
lib/scorecard_record.mts   records saved judge batches into evals/scorecards/<skill>/<task>.json
lib/scorecard_markdown.mts deterministic GitHub-previewable Markdown generator for evals/SCORECARD.md
lib/scorecard_html.mts     self-contained interactive offline HTML scorecard dashboard generator
lib/scorecard.test.mts     offline tests for scorecard schema, hashing, staleness, recording, Markdown, and HTML
tasks/<task>/
  instruction.md           the prompt; never mentions the skill or the report format
  task.toml                Harbor configuration; skills go to /skills
  environment/             Dockerfile, plus base/ (and change/ for review tasks)
  tests/                   test.sh, judge.json, plus expected.json (review) or contract tests (implementation); uploaded after the agent finishes
  solution/solve.sh        reference review or implementation for Harbor's oracle agent
```

## Scores

`reward.json` holds one score per deterministic check, so you can see which one regressed.

**Review tasks:**

| Metric | 1 means |
|---|---|
| `report_exists` | `/output/REVIEW.md` was written |
| `format` | Verdict, Checks run and Not assessed are present, and every finding has a location, category and evidence |
| `verdict` | The verdict is one of the task's allowed verdicts |
| `found` | Each expected finding was reported at the right file and line (±2 lines); a fraction when several are expected |
| `severity`, `category` | The matched findings have the expected severity and category |
| `restraint` | No unexpected finding is rated above the task's limit |
| `guideline` | At least one finding cites a guideline ID (canary only) |
| `reward` | Every metric above is 1 |

**Kotlin implementation tasks:**

| Metric | 1 means |
|---|---|
| `has_production_code` | At least one nonempty `.kt` file exists in the task's production package |
| `has_tests` | At least one nonempty `.kt` file exists in the task's test package |
| `agent_tests_pass` | The agent's tests pass offline. Meeting Room Booking also builds an executable `bootJar`. |
| `contract_tests_pass` | The task's hidden JUnit tests pass offline |
| `reward` | Every metric above is 1 |

**TypeScript implementation & refactoring tasks:**

| Metric | 1 means |
|---|---|
| `has_production_code` | At least one nonempty `.ts` file exists under `src/` (`refactor-gilded-rose`) |
| `has_tests` | At least one nonempty `.ts` file exists under `tests/` (`refactor-gilded-rose`) |
| `typecheck_pass` / `build_pass` | `pnpm typecheck` (`refactor-gilded-rose`) or `pnpm build` (`implement-react-router-todo`) passes |
| `agent_tests_pass` | At least one agent test runs and the suite passes |
| `contract_tests_pass` | The hidden verifier tests pass |
| `reward` | Every metric above is 1 |

These deterministic scores measure compliance and correctness, not qualitative review reasoning
or code craft. Keep them separate from the optional host-side judge scores below.

## Direct Harbor commands

Requires Node.js 22.18+ (no package install or build step), Docker, Harbor
(`uv tool install harbor`) and Codex credentials. Run from the repository root. For your local
Codex login, set `CODEX_AUTH_JSON_PATH="${CODEX_HOME:-$HOME/.codex}/auth.json"`; for API
authentication, set `OPENAI_API_KEY` instead.

```bash
# 1. Check the tasks without Docker, then stage the shared grader into each task's tests/ folder
#    (pnpm eval does this automatically; direct harbor commands need it first).
node evals/code-change/lib/selfcheck.mts
bash evals/code-change/lib/sync.sh

# 2. Check the wiring in Docker: oracle should score 1, nop 0.
harbor run -p evals/code-change/tasks -a oracle
harbor run -p evals/code-change/tasks -a nop

# 3. Canary with the skill. If it fails, the skill did not load; stop and investigate.
harbor run -p evals/code-change/tasks/canary -a codex -m <model> --skill skills/code-change --artifact /output/REVIEW.md

# 4. Every task, 5 attempts each, with and without the skill.
harbor run -p evals/code-change/tasks -a codex -m <model> -k 5 -n 2 --skill skills/code-change --artifact /output/REVIEW.md
harbor run -p evals/code-change/tasks -a codex -m <model> -k 5 -n 2 --artifact /output/REVIEW.md
```

Compare the two runs in step 4 task by task. Record a baseline before changing the skill, then
rerun after each change.

The Docker smoke checks require every oracle trial to score 1 and every nop trial to score 0.
These checks confirm task loading and verification in Docker. They do not test live Codex authentication.

### Amp in Harbor

The custom adapter in `lib/amp_agent.py` runs Amp CLI inside the task container using
`--executor local`, not in another orb. Requires Harbor 0.27+ and `AMP_EVAL_API_KEY` set to an
Amp access token from [Settings → Security](https://ampcode.com/settings/security).
Amp reserves `AMP_API_KEY` in remote orbs; the adapter maps `AMP_EVAL_API_KEY` to the
container's `AMP_API_KEY` only for the agent process at runtime. Do not put the credential
in the Dockerfile, command-line arguments, or saved Harbor configuration. This adapter does not
forward the parent orb's short-lived thread identity. Inference uses the token owner's Amp
model routing and billing.

Run from the repository root:

```bash
# Validate the task and verifier before spending inference.
pnpm eval check
pnpm eval smoke --task implement-mars-rover

# First verify skill discovery with the canary, then run one Mars rover trial.
PYTHONPATH="$PWD/evals/code-change/lib${PYTHONPATH:+:$PYTHONPATH}" \
  harbor run -p evals/code-change/tasks/canary -a amp_agent:AmpAgent \
  -m openai/gpt-6.1-terra --ak reasoning_effort=high -n 1 -k 1 \
  --skill skills/code-change --artifact /output/REVIEW.md \
  -o eval-results/harbor --job-name amp-canary

PYTHONPATH="$PWD/evals/code-change/lib${PYTHONPATH:+:$PYTHONPATH}" \
  harbor run -p evals/code-change/tasks/implement-mars-rover -a amp_agent:AmpAgent \
  -m openai/gpt-6.1-terra --ak reasoning_effort=high -n 1 -k 1 \
  --skill skills/code-change -o eval-results/harbor --job-name amp-mars-rover

# Opt-in Amp run with judge-code (requires OPENROUTER_API_KEY in host env; omit --skill skills/code-change for baseline + judge-code)
PYTHONPATH="$PWD/evals/code-change/lib${PYTHONPATH:+:$PYTHONPATH}" \
  harbor run -p evals/code-change/tasks/refactor-gilded-rose -a amp_agent:AmpAgent \
  -m openai/gpt-6.1-terra --ak reasoning_effort=high --ak with_judge_code=true -n 1 -k 1 \
  --skill skills/code-change --skill skills/judge-code \
  --ae 'OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' \
  -o eval-results/harbor --job-name amp-gilded-rose-with-judge-code
```

Use a fresh job name for each run. Add `--install-only` to check container installation and
skill registration without credentials or inference. Amp is installed with npm at setup time;
use `--ak version=<npm-version>` to pin its version. Supplied skills are copied into Amp's
user skill directory without changing the task prompt. By default, `AmpAgent` never forwards
host `OPENROUTER_API_KEY`; pass `--ak with_judge_code=true` (and `--skill skills/judge-code`,
optionally paired with `--ae 'OPENROUTER_API_KEY=${OPENROUTER_API_KEY}'`) to opt into in-container
`judge-code` linting and append the required quality-gate instruction. The adapter enables automatic tool
approval inside the disposable container, saves native stream logs under `agent/`, and parses token
usage and cost from `amp.stdout.jsonl` into Harbor's `AgentContext` post-run (falling back
gracefully to `None` when fields are absent). Keep Amp results
separate from Codex results; `pnpm eval run` and automatic latest-run discovery remain Codex-only.
Account-level Amp skills and plugins can also affect results; use a dedicated eval account if
you need isolation from personal configuration.

## OpenRouter quality scoring

Run this after Harbor finishes. It uses `OPENROUTER_API_KEY` on the host, independently of the
Codex credentials used by the evaluated agent. The key is never included in a saved request.
No SDK or package install is needed. Both models use the
[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).

Each task's hidden `tests/judge.json` defines binary pass/fail questions and an optional `target`
(`"review"` by default, or `"production_code"`), or composes one or more shared skill-level rubric
facets from the repository-root `rubrics/` directory via `"extends"` (for example,
`{ "extends": ["domain-modelling", "readability", "module-design", "solid"] }`):

- **Review tasks (`lib/judge_review.mts`):** The judge receives the requirement, numbered base
  and feature Kotlin files, and the full review. It accepts free-form reviews; the deterministic
  Markdown parser does not filter what the judge sees. The canary asks about duplicated SKU
  validation and the weak test; the seeded task asks about the actual threshold defect, its
  consequence, and unsupported findings; the clean task asks about correct behavior and
  unsupported findings.
- **Implementation tasks (`lib/judge_code.mts`):** The judge receives the requirement and the
  exported production files under `src/main/kotlin` by default or the task rubric's
  `source_root` (the todo task uses `src`). With
  `--scope whole` (default), all production files are judged in one request. With
  `--scope per-file`, each production file is judged separately against the same rubric, and
  results report both mean `pass_rate` and strict `all_files_pass_rate` (fraction of checks
  passing across every file).

The normal terminal workflow is `pnpm eval judge --latest`, described above. For direct use
of the single-report script, after setting `OPENROUTER_API_KEY` in your shell, set `REVIEW_PATH`
to a real exported report. The example path below is a placeholder and must be replaced.
Use the matching task folder. For example, compare the same seeded-bug review with both judges:

```bash
REVIEW_PATH="/path/to/exported/REVIEW.md"
JUDGE_RUN_ROOT="$(mktemp -d)"

node evals/code-change/lib/judge_review.mts \
  --task evals/code-change/tasks/review-seeded-bug \
  --report "$REVIEW_PATH" --model typesafe/jev-1.14 \
  --out "$JUDGE_RUN_ROOT/jev"

node evals/code-change/lib/judge_review.mts \
  --task evals/code-change/tasks/review-seeded-bug \
  --report "$REVIEW_PATH" --model liquid/d1.2-ultra \
  --out "$JUDGE_RUN_ROOT/d1"
```

Every run needs a new output directory to prevent overwriting earlier scores. It saves:

- `request.json`: the exact model, questions, source context, and review sent to OpenRouter.
- `response.txt`: the raw response, including the returned model snapshot and usage when provided.
- `result.json`: status, requested/returned model IDs, rubric ID, `deterministic` scores, and
  separate `quality` scores. Each check includes the choice, pass probability, and confidence.
  `quality.pass_rate` is the fraction of questions answered `pass`, not a probability of correctness.
- The terminal wrapper also creates `report.html` for single and batch judgments. It updates
  batch reports as results arrive and preserves error/pending states if judging stops early.

Add `--dry-run` to save and inspect a request without credentials or a network call. Missing
reports return `missing_report` and no model score. Transient HTTP `429`, `502`, `503`, and `504`
responses retry up to 4 times with bounded exponential backoff and jitter (respecting
`Retry-After` when present). Hard HTTP errors (`400`, `401`, `403`, `404`), network/timeout
failures (30 seconds per attempt), refusals, or malformed-answer failures fail immediately with
no retry, return `error`, save no quality score, and exit nonzero. Setup errors also exit
nonzero. Interrupted batch runs can be continued in-place with `pnpm eval judge --resume DIRECTORY`
without re-scoring already-`scored` trials; single-report runs can be rerun into a new output
directory. Host-side scores do not replace Harbor's `reward.json`.

Judge accuracy and confidence thresholds are **not yet calibrated**. First label sample reviews
by hand, including correct paraphrases, missed bugs, wrong claims at the expected line, and
false alarms under unfamiliar headings. Compare each judge's decisions against those labels.
Use a separate held-out set before choosing a default model or confidence threshold.

Run all offline checks with:

```bash
pnpm eval check
```

## Adding a task

1. Copy a task folder of the same kind and replace its starter, fixtures, and `instruction.md`.
2. For a review task, write `tests/expected.json` using `ExpectedReview` in `lib/grade_review.mts`.
   For an implementation task, write hidden contract tests and wire them into `tests/test.sh`.
3. Write the reference solution in `solution/solve.sh`.
4. Configure `tests/judge.json`: implementation/kata tasks can compose shared rubric facets via
   `{ "extends": ["domain-modelling", "readability", "module-design", "solid"] }` (or a single
   facet name), while task-specific rubrics define `rubric` as a stable ID and `questions` as named
   `choice` questions, each with `instructions` and exactly `pass`/`fail` criteria. Update the
   rubric ID when its meaning changes; saved requests retain the exact text.
5. Run `pnpm eval check` (and `pnpm eval smoke --task <task>` once ready; `pnpm eval` stages `lib/grade_review.mts` into `tests/` automatically).

Keep a few tasks you never look at while editing the skill. Wording tuned until specific tasks
pass makes the skill good at those tasks only.

## Adding a harness

Harbor has built-in agents for many harnesses (`-a claude-code`, `-a codex`, …). For any other
harness, write a custom agent (`-a module.path:ClassName`, extending Harbor's
`BaseInstalledAgent`). For each harness, record:

- how to install its CLI in the container;
- how to run it headless: prompt, auto-approval and model selection;
- the environment variable that holds its API key;
- where it loads skills from, or, if it has none, how the adapter points the agent at `/skills`.

Run `canary` first for every new harness. Compare results with and without the skill within a
harness, not across harnesses: each harness loads skills differently.
