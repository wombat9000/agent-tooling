#!/usr/bin/env python3
"""Check the eval tasks without Docker or a harness.

For each task: the grader copy matches lib/, the reference solution scores 1
(what Harbor's oracle agent should get), and a missing report scores 0 (what the
nop agent should get). Also checks that typical bad reviews score 0.

Usage: python3 evals/code-change/lib/selfcheck.py
"""

import filecmp
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

LIB = Path(__file__).resolve().parent
TASKS = LIB.parent / "tasks"
sys.path.insert(0, str(LIB))
from grade_review import grade  # noqa: E402


def expected(task: str) -> dict:
    return json.loads((TASKS / task / "tests" / "expected.json").read_text(encoding="utf-8"))


def reference_report(task: str) -> str:
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(["bash", str(TASKS / task / "solution" / "solve.sh")],
                       env={**os.environ, "OUTPUT_DIR": out}, check=True)
        return (Path(out) / "REVIEW.md").read_text(encoding="utf-8")


class TaskWiring(unittest.TestCase):
    def test_each_task(self):
        tasks = sorted(p.name for p in TASKS.iterdir() if (p / "task.toml").is_file())
        self.assertTrue(tasks)
        for task in tasks:
            with self.subTest(task=task):
                self.assertTrue(filecmp.cmp(LIB / "grade_review.py",
                                            TASKS / task / "tests" / "grade_review.py",
                                            shallow=False), "run lib/sync.sh")
                self.assertEqual(grade(reference_report(task), expected(task))["reward"], 1)
                self.assertEqual(grade(None, expected(task))["reward"], 0)


class BadReviews(unittest.TestCase):
    def test_missing_the_seeded_bug_fails(self):
        report = reference_report("review-seeded-bug").replace("### Blocking", "### Optional")
        self.assertEqual(grade(report, expected("review-seeded-bug"))["severity"], 0)

    def test_invented_finding_on_clean_change_fails(self):
        report = reference_report("review-clean-change") + (
            "\n### Should fix — Thresholds should be configurable\n"
            "- Location: src/main/kotlin/shop/ShippingPolicy.kt:12\n"
            "- Category: design\n- Evidence: hypothesis — may change later\n")
        metrics = grade(report, expected("review-clean-change"))
        self.assertEqual(metrics["restraint"], 0)
        self.assertEqual(metrics["reward"], 0)

    def test_review_without_the_skill_format_fails_canary(self):
        report = ("The import duplicates the SKU check and crashes on lines without a comma. "
                  "The test only asserts that the result is not null.\n")
        self.assertEqual(grade(report, expected("canary"))["reward"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
