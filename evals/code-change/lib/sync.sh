#!/usr/bin/env bash
# Copies the shared grader into every task's tests/ directory. Harbor uploads each
# task's tests/ on its own, so every task needs its own copy.
set -eu
lib="$(cd "$(dirname "$0")" && pwd)"
for task in "$lib"/../tasks/*/; do
  cp "$lib/grade_review.mts" "$task/tests/grade_review.mts"
done
