#!/usr/bin/env bash
# Reference solution for Harbor's oracle agent: a review that should score 1.
set -eu
out="${OUTPUT_DIR:-/output}"
mkdir -p "$out"
cat > "$out/REVIEW.md" <<'EOF'
Verdict: ready

No findings. The change meets the requirement: `chargeFor` uses a strict `>` comparison, and the
tests cover 50.00, 50.01 and a smaller order, with expected values taken from the requirement.

Pre-existing: none
Checks run: traced ShippingPolicy.chargeFor, Order.subtotal and ShippingPolicyTest
Not assessed: none
EOF
