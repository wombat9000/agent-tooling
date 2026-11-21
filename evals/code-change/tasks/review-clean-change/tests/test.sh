#!/usr/bin/env bash
# Grades /output/REVIEW.md against expected.json and writes Harbor's reward file.
set -u
node /tests/grade_review.mts \
  --report /output/REVIEW.md \
  --expected /tests/expected.json \
  --out /logs/verifier/reward.json
