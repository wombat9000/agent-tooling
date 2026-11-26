#!/usr/bin/env bash
set -eu

workspace="${WORKSPACE_DIR:-/workspace}"
out="${VERIFIER_LOG_DIR:-/logs/verifier}"
verifier="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out"
out="$(cd -- "$out" && pwd)"
cd "$workspace"

injected="$(mktemp -d "$PWD/.gilded-rose-verifier.XXXXXX")"
trap 'rm -rf -- "$injected"' EXIT

has_production_code=0
if [ -d src ] && [ -n "$(find src -type f -name '*.ts' -size +0c -print -quit)" ]; then
  has_production_code=1
fi

has_tests=0
if [ -d tests ] && [ -n "$(find tests -type f -name '*.ts' -size +0c -print -quit)" ]; then
  has_tests=1
fi

check_tap_passed() {
  local tap_file="$1"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const text = readFileSync(process.argv[1], "utf8");
    const metric = (name) => {
      const m = text.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
      return m ? Number(m[1]) : null;
    };
    const tests = metric("tests");
    const pass = metric("pass");
    const fail = metric("fail");
    const cancelled = metric("cancelled");
    if (!tests || tests < 1 || pass !== tests || fail !== 0 || (cancelled !== null && cancelled !== 0)) {
      process.exit(1);
    }
  ' "$tap_file"
}

typecheck_pass=0
agent_tests_pass=0
contract_tests_pass=0

if [ "$has_production_code" -eq 1 ]; then
  if pnpm typecheck; then
    typecheck_pass=1
  fi

  if [ "$has_tests" -eq 1 ]; then
    if pnpm test &&
      pnpm exec tsx --test --test-reporter=tap tests > "$injected/agent.tap" &&
      check_tap_passed "$injected/agent.tap"; then
      agent_tests_pass=1
    elif [ -f "$injected/agent.tap" ]; then
      cat "$injected/agent.tap"
    fi
  fi

  cp "$verifier/contract.test.ts" "$injected/contract.test.ts"
  if pnpm exec tsx --test --test-reporter=tap "$injected/contract.test.ts" > "$injected/contract.tap" &&
    check_tap_passed "$injected/contract.tap"; then
    contract_tests_pass=1
  elif [ -f "$injected/contract.tap" ]; then
    cat "$injected/contract.tap"
  fi
fi

reward=$((has_production_code * has_tests * typecheck_pass * agent_tests_pass * contract_tests_pass))
cat > "$out/reward.json" <<SCORES
{
  "has_production_code": $has_production_code,
  "has_tests": $has_tests,
  "typecheck_pass": $typecheck_pass,
  "agent_tests_pass": $agent_tests_pass,
  "contract_tests_pass": $contract_tests_pass,
  "reward": $reward
}
SCORES
cat "$out/reward.json"
