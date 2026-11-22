#!/usr/bin/env bash
# Copies the shared grader into every task's tests/ directory (gitignored).
# `pnpm eval` runs this automatically; run manually before calling `harbor` directly.
set -eu
lib="$(cd "$(dirname "$0")" && pwd)"
for task in "$lib"/../tasks/*/; do
  [ -f "$task/task.toml" ] || continue
  cp "$lib/grade_review.mts" "$task/tests/grade_review.mts"
done
