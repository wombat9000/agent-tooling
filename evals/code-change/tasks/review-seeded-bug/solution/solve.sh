#!/usr/bin/env bash
# Reference solution for Harbor's oracle agent: a review that should score 1.
set -eu
out="${OUTPUT_DIR:-/output}"
mkdir -p "$out"
cat > "$out/REVIEW.md" <<'EOF'
Verdict: needs rework

### Blocking — Orders of exactly 100.00 receive the discount
- Location: src/main/kotlin/shop/PricingPolicy.kt:18
- Category: correctness
- Evidence: traced — `subtotal >= discountThreshold` is true for a subtotal of 100.00, so
  such an order pays 95.00; the requirement says orders of exactly 100.00 pay the full subtotal.
- Consequence: customers with 100.00 orders are undercharged by 5.00.
- Fix: compare with `>`; verify with a test for a 100.00 order expecting 100.00.

### Should fix — No test on either side of the threshold
- Location: src/test/kotlin/shop/PricingPolicyTest.kt:17
- Category: test gap · T4
- Evidence: traced — the tests use 150.00 and 50.00, so the `>=` implementation passes them.
- Consequence: the boundary defect above is not caught.
- Fix: add tests for 100.00 (expect 100.00) and 100.01 (expect 95.01).

Pre-existing: none
Checks run: traced PricingPolicy.totalFor and its tests
Not assessed: none
EOF
