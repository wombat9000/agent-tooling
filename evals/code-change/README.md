# code-change evals

Measures whether the [code-change](../../skills/code-change/SKILL.md) skill improves an agent's
code reviews and greenfield implementations. The tasks are plain folders: a fixture or starter
repository, an instruction, and a deterministic verifier. They depend on no harness.
[Harbor](https://github.com/harbor-framework/harbor) runs them.

Codex is the only harness used for now. See [Adding a harness](#adding-a-harness).

## Quick start

From the repository root, use `pnpm eval`. Node.js 22.18+ is required. There are no runtime
packages to install. Docker and Harbor (`uv tool install harbor`) are needed for container runs.

```bash
pnpm eval check             # All offline tests
pnpm eval smoke             # Docker: oracle must score 1, nop must score 0
pnpm eval canary            # One Codex trial with the skill
pnpm eval run               # All tasks with the skill: 5 attempts each, 4 concurrent
pnpm eval run --baseline    # Same settings without the skill
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
pnpm eval judge --latest --judge jev                          # Same reports, Jev
```

Each judge run creates a standalone `report.html` with a Check × Trial matrix (sorted worst-first,
with hoverable rubric criteria and trial/file breakdowns), task KPI summaries, failure-first check
tables, P(pass), confidence, and the original review or tabbed, syntax-highlighted Kotlin source.
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

No artifact paths are needed for saved runs. The latest run is selected by its completion time;
unfinished runs and oracle/nop jobs are excluded. Use `--run DIRECTORY` to choose a specific
saved Harbor run. To score one review file or exported `src/main/kotlin` directory manually, use
`pnpm eval judge TASK PATH`.

Judge runs get a unique directory under `eval-results/judges/`. Batch runs contain one
directory per trial and a `summary.json` with the source run and each trial's status and score.
Every selected artifact is checked before API calls begin. Missing artifacts cause an error;
they are not silently skipped. Judging stops at the first API error and leaves later trials
marked `pending`, with earlier results retained. `eval-results/` and Harbor's
older `jobs/` directory are ignored by Git; existing results are retained. OpenRouter keys
are used only for host-side judging and are not passed to Harbor by this wrapper.

Use `--model ID` or `EVAL_MODEL` to change the Codex model. Use `--effort LEVEL` and
`--service-tier TIER` to override the reasoning effort and service tier. These defaults apply
equally to skill and baseline runs. Use `--judge MODEL_ID` for another
OpenRouter judge, and `--scope whole|per-file` to control whether `production_code` tasks are
judged across all production files at once (default `whole`) or one file per request (`per-file`).
`--task NAME`, `--attempts N`, and `--concurrency N` can narrow a full run.
Add `--dry-run` to preview Harbor commands without starting them. For judging, it saves the
request without making an API call. `pnpm eval --help` lists all options.

## Tasks

| Task | Kind | What a good run does |
|---|---|---|
| `canary` | Review | Uses the skill's report format and cites a guideline ID. Passes only if the skill loaded; run it first. |
| `review-seeded-bug` | Review | Reports the `>=` threshold bug as **Blocking** correctness at `PricingPolicy.kt:18`. |
| `review-clean-change` | Review | Returns `Verdict: ready` and raises nothing above **Optional**. |
| `implement-mars-rover` | Implementation | Implements `rover.MarsRover.execute(inputFile: Path): String` in Kotlin, passes its own and hidden black-box JUnit 5 contract tests, and keeps production code clean and modular. |

Review tasks ask the agent to write `/output/REVIEW.md` and grade report structure and finding
labels deterministically. Implementation tasks export `/workspace/src` and verify build, agent
tests, and hidden contract tests with Gradle inside the container. In both cases, an optional
host-side judge uses OpenRouter to assess qualitative criteria after the trial.

## Layout

```
cli.mts                    terminal shortcuts used by pnpm eval
cli.test.mts               offline tests of defaults, auth, and child commands
lib/grade_review.mts       shared review grader: REVIEW.md + expected.json → /logs/verifier/reward.json
lib/sync.sh                stages lib/grade_review.mts into review tasks' tests/ for direct harbor runs (gitignored; pnpm eval does this automatically)
lib/selfcheck.mts          checks review tasks without Docker: reference solution scores 1, no report 0
lib/judge_review.mts       scores a saved review with an OpenRouter decision model (plus shared rubric/API helpers)
lib/judge_review.test.mts  offline tests of review judge requests, responses, and failure handling
lib/judge_code.mts         scores exported production Kotlin code (whole or per-file) with an OpenRouter decision model
lib/judge_code.test.mts    offline tests of code judging, per-file aggregation, and failure handling
lib/highlight_kotlin.mts   zero-dependency build-time Kotlin syntax highlighter for HTML reports
lib/html_report.mts        standalone HTML report from saved rubric questions, judge scores, and artifacts
rubrics/
  domain-modelling.json    shared facet: immutability, domain invariants, boundary separation
  readability.json         shared facet: direct readability and named domain expressions
  module-design.json       shared facet: file-level modular organization and avoiding speculative abstraction
  solid.json               shared facet: pragmatic SOLID principles (SRP, OCP, LSP, ISP, DIP)
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

**Implementation tasks (`implement-mars-rover`):**

| Metric | 1 means |
|---|---|
| `production_code_exists` | At least one `.kt` file exists under `src/main/kotlin/rover/` |
| `agent_tests_exists` | At least one `.kt` test file exists under `src/test/kotlin/` |
| `agent_tests_pass` | `./gradlew --offline test` passes on the agent's own tests |
| `contract_tests_pass` | `./gradlew --offline test` passes with the hidden `VerifierMarsRoverContractTest` injected |
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
harbor run -p evals/code-change/tasks -a codex -m <model> -k 5 -n 4 --skill skills/code-change --artifact /output/REVIEW.md
harbor run -p evals/code-change/tasks -a codex -m <model> -k 5 -n 4 --artifact /output/REVIEW.md
```

Compare the two runs in step 4 task by task. Record a baseline before changing the skill, then
rerun after each change.

All four tasks pass the Docker oracle and nop checks. These checks confirm loading the task
directory and running verification in Docker. They do not test live Codex authentication.

## OpenRouter quality scoring

Run this after Harbor finishes. It uses `OPENROUTER_API_KEY` on the host, independently of the
Codex credentials used by the evaluated agent. The key is never included in a saved request.
No SDK or package install is needed. Both models use the
[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).

Each task's hidden `tests/judge.json` defines binary pass/fail questions and an optional `target`
(`"review"` by default, or `"production_code"`), or composes one or more shared skill-level rubric
facets under `rubrics/` via `"extends"` (for example,
`{ "extends": ["domain-modelling", "readability", "module-design", "solid"] }`):

- **Review tasks (`lib/judge_review.mts`):** The judge receives the requirement, numbered base
  and feature Kotlin files, and the full review. It accepts free-form reviews; the deterministic
  Markdown parser does not filter what the judge sees. The canary asks about duplicated SKU
  validation and the weak test; the seeded task asks about the actual threshold defect, its
  consequence, and unsupported findings; the clean task asks about correct behavior and
  unsupported findings.
- **Implementation tasks (`lib/judge_code.mts`):** The judge receives the requirement and the
  exported production Kotlin files (`src/main/kotlin/**/*.kt`, excluding test files). With
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
reports return `missing_report` and no model score. Network, HTTP, refusal, or malformed-answer
failures return `error`, save no quality score, and exit nonzero. Setup errors also exit nonzero.
Requests time out after 30 seconds and are not retried automatically. A failed request can be
rerun with a new output directory. Host-side scores do not replace Harbor's `reward.json`.

Judge accuracy and confidence thresholds are **not yet calibrated**. First label sample reviews
by hand, including correct paraphrases, missed bugs, wrong claims at the expected line, and
false alarms under unfamiliar headings. Compare each judge's decisions against those labels.
Use a separate held-out set before choosing a default model or confidence threshold.

Run all offline checks with:

```bash
pnpm eval check
```

## Adding a task

1. Copy a task folder, and replace `environment/base/`, `environment/change/` and the
   requirement in `instruction.md`.
2. Write `tests/expected.json`. Its fields are defined by `ExpectedReview` in `lib/grade_review.mts`.
3. Write a reference review in `solution/solve.sh`.
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
