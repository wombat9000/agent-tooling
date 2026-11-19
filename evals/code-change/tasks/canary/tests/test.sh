#!/usr/bin/env bash
# Grades /output/REVIEW.md against expected.json and writes Harbor's reward file.
set -u
python3 /tests/grade_review.py \
  --report /output/REVIEW.md \
  --expected /tests/expected.json \
  --out /logs/verifier/reward.json
