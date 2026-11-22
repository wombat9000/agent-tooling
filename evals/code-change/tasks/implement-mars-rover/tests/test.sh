#!/usr/bin/env bash
# Verifies that the agent wrote Kotlin production + test code under package rover,
# its own test suite passes, and the hidden v3 phase-one contract test suite passes.
set -u

out="/logs/verifier/reward.json"
mkdir -p "$(dirname "$out")"

injected_test="/workspace/src/test/kotlin/rover/VerifierMarsRoverContractTest.kt"
cleanup() {
  rm -f "$injected_test"
}
trap cleanup EXIT

has_prod=0
if [ -d /workspace/src/main/kotlin/rover ] && find /workspace/src/main/kotlin/rover -type f -name '*.kt' -size +0c | grep -q .; then
  has_prod=1
fi

has_tests=0
if [ -d /workspace/src/test/kotlin/rover ] && find /workspace/src/test/kotlin/rover -type f -name '*.kt' -size +0c | grep -q .; then
  has_tests=1
fi

agent_tests_pass=0
if [ "$has_prod" -eq 1 ] && [ "$has_tests" -eq 1 ]; then
  if (cd /workspace && ./gradlew --no-daemon test --offline); then
    if [ -d /workspace/build/test-results/test ] && find /workspace/build/test-results/test -name 'TEST-*.xml' | grep -q .; then
      if grep -h '<testsuite ' /workspace/build/test-results/test/TEST-*.xml | grep -q 'tests="[1-9]'; then
        if ! grep -h '<testsuite ' /workspace/build/test-results/test/TEST-*.xml | grep -Eq '(failures|errors)="[1-9]'; then
          agent_tests_pass=1
        fi
      fi
    fi
  fi
fi

contract_tests_pass=0
if [ "$has_prod" -eq 1 ]; then
  mkdir -p /workspace/src/test/kotlin/rover
  cp /tests/VerifierMarsRoverContractTest.kt "$injected_test"
  if (cd /workspace && ./gradlew --no-daemon test --offline --tests 'rover.VerifierMarsRoverContractTest' --rerun-tasks); then
    xml="/workspace/build/test-results/test/TEST-rover.VerifierMarsRoverContractTest.xml"
    if [ -f "$xml" ] && grep -q 'tests="[1-9]' "$xml" && ! grep -Eq '(failures|errors)="[1-9]' "$xml"; then
      contract_tests_pass=1
    fi
  fi
  rm -f "$injected_test"
fi

reward=0
if [ "$has_prod" -eq 1 ] && [ "$has_tests" -eq 1 ] && [ "$agent_tests_pass" -eq 1 ] && [ "$contract_tests_pass" -eq 1 ]; then
  reward=1
fi

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
