#!/usr/bin/env bash
set -eu

cd /workspace
out=/logs/verifier/reward.json
mkdir -p "$(dirname "$out")"

has_prod=0
if [ -d src/main/kotlin/billing ] && [ -n "$(find src/main/kotlin/billing -type f -name '*.kt' -size +0c -print -quit)" ]; then
  has_prod=1
fi

has_tests=0
if [ -d src/test/kotlin/billing ] && [ -n "$(find src/test/kotlin/billing -type f -name '*.kt' -size +0c -print -quit)" ]; then
  has_tests=1
fi

agent_tests_pass=0
if [ "$has_prod" -eq 1 ] && [ "$has_tests" -eq 1 ]; then
  if ./gradlew --no-daemon --offline bootJar test && \
    grep -h '<testcase ' build/test-results/test/TEST-*.xml | grep -q .; then
    agent_tests_pass=1
  fi
fi

contract_tests_pass=0
if [ "$has_prod" -eq 1 ]; then
  test_class=VerifierInvoiceDisputesContractTest
  injected="src/test/kotlin/billing/$test_class.kt"
  trap 'rm -f "$injected"' EXIT
  mkdir -p "$(dirname "$injected")"
  cp "/tests/$test_class.kt" "$injected"

  xml="build/test-results/test/TEST-billing.$test_class.xml"
  if ./gradlew --no-daemon --offline test --tests "billing.$test_class" --rerun-tasks && \
    grep -Eq '<testsuite .*tests="[1-9][0-9]*"' "$xml" && \
    ! grep -Eq '(skipped|failures|errors)="[1-9]' "$xml"; then
    contract_tests_pass=1
  elif [ -f "$xml" ]; then
    echo "--- $xml ---"
    cat "$xml"
  fi
fi

reward=$((has_prod * has_tests * agent_tests_pass * contract_tests_pass))
cat > "$out" <<EOF
{
  "has_production_code": $has_prod,
  "has_tests": $has_tests,
  "agent_tests_pass": $agent_tests_pass,
  "contract_tests_pass": $contract_tests_pass,
  "reward": $reward
}
EOF
cat "$out"
