#!/usr/bin/env bash
set -eu

workspace="${WORKSPACE_DIR:-/workspace}"
out="${VERIFIER_LOG_DIR:-/logs/verifier}"
verifier="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out"
out="$(cd -- "$out" && pwd)"
cd "$workspace"
injected="$(mktemp -d "$PWD/.todo-verifier.XXXXXX")"
trap 'rm -rf -- "$injected"' EXIT

build_pass=0
agent_tests_pass=0
contract_tests_pass=0

if pnpm build; then
  build_pass=1

  if pnpm exec playwright test --reporter=json > "$injected/agent-results.json" &&
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const { stats } = JSON.parse(readFileSync(process.argv[1], "utf8"));
      if (!stats || stats.expected < 1 || stats.unexpected || stats.flaky) process.exit(1);
    ' "$injected/agent-results.json"; then
    agent_tests_pass=1
  else
    cat "$injected/agent-results.json"
  fi

  if cp "$verifier"/{contract.spec.mjs,playwright.config.mjs} "$injected/" &&
    pnpm exec playwright test --config "$injected/playwright.config.mjs" --reporter=line; then
    contract_tests_pass=1
  fi
fi

cat > "$out/reward.json" <<SCORES
{
  "build_pass": $build_pass,
  "agent_tests_pass": $agent_tests_pass,
  "contract_tests_pass": $contract_tests_pass,
  "reward": $((build_pass * agent_tests_pass * contract_tests_pass))
}
SCORES
cat "$out/reward.json"
