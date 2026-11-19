# code-change evals

Measures whether the [code-change](../../skills/code-change/SKILL.md) skill makes an agent's
reviews correct and consistent. The tasks are plain folders: a fixture repository, an
instruction, and a grader that reads only the report file the agent writes. They depend on no
harness. [Harbor](https://github.com/harbor-framework/harbor) runs them.

Codex is the only harness used for now. See [Adding a harness](#adding-a-harness).

## Tasks

| Task | What a good run does |
|---|---|
| `canary` | Uses the skill's report format and cites a guideline ID. Passes only if the skill loaded; run it first. |
| `review-seeded-bug` | Reports the `>=` threshold bug as **Blocking** correctness at `PricingPolicy.kt:18`. |
| `review-clean-change` | Returns `Verdict: ready` and raises nothing above **Optional**. |

Each task asks the agent to write its review to `/output/REVIEW.md`. Graders can only read
files, and the fixed report template makes scoring deterministic: no grading model is needed.

## Layout

```
lib/grade_review.py   shared grader: REVIEW.md + expected.json → /logs/verifier/reward.json
lib/sync.sh           copies the grader into each task (Harbor uploads tests/ per task)
lib/selfcheck.py      checks the tasks without Docker: reference solution scores 1, no report 0
tasks/<task>/
  instruction.md      the prompt; never mentions the skill or the report format
  task.toml           Harbor configuration; skills go to /skills
  environment/        Dockerfile, plus base/ and change/, which become the `main` and `feature` branches
  tests/              test.sh, expected.json and a grader copy; uploaded after the agent finishes
  solution/solve.sh   reference review for Harbor's oracle agent
```

## Scores

`reward.json` holds one score per check, so you can see which one regressed:

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

## Running

Requires Docker, Harbor (`uv tool install harbor`) and a Codex API key. Run from the repository
root.

```bash
# 1. Check the tasks without Docker.
python3 evals/code-change/lib/selfcheck.py

# 2. Check the wiring in Docker: oracle should score 1, nop 0.
harbor run -p evals/code-change/tasks -a oracle
harbor run -p evals/code-change/tasks -a nop

# 3. Canary with the skill. If it fails, the skill did not load; stop and investigate.
harbor run -p evals/code-change/tasks/canary -a codex -m <model> --skill skills/code-change

# 4. Every task, 5 attempts each, with and without the skill.
harbor run -p evals/code-change/tasks -a codex -m <model> -k 5 -n 4 --skill skills/code-change
harbor run -p evals/code-change/tasks -a codex -m <model> -k 5 -n 4
```

Compare the two runs in step 4 task by task. Record a baseline before changing the skill, then
rerun after each change.

To be confirmed on the first run (Harbor's CLI reference is not yet published):

- `-p` with a directory of tasks; if it expects a dataset, run each task path separately.
- How Harbor passes the Codex API key into the container.
- Whether the shared verifier environment keeps `/output` from the agent phase. If it does not,
  declare `/output` as an artifact in `task.toml`.

## Adding a task

1. Copy a task folder, and replace `environment/base/`, `environment/change/` and the
   requirement in `instruction.md`.
2. Write `tests/expected.json`. The keys are documented in `lib/grade_review.py`.
3. Write a reference review in `solution/solve.sh`.
4. Run `lib/sync.sh`, then `lib/selfcheck.py`.

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
