import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createCliTestWorkspace,
  findFileEntry,
  readSavedRequest,
  writeExecutableScript,
} from './helpers/cli-harness.mts';

function writeMixedAppFixture(project: string): void {
  const mixed = join(project, 'mixed-app');
  mkdirSync(join(mixed, 'src'), { recursive: true });
  mkdirSync(join(mixed, 'e2e'), { recursive: true });
  mkdirSync(join(mixed, 'tests'), { recursive: true });

  writeFileSync(join(mixed, 'src/calc.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  writeFileSync(join(mixed, 'src/calc.test.ts'), 'import { add } from "./calc"; if (add(1, 2) !== 3) throw new Error();\n');
  writeFileSync(join(mixed, 'tests/api.integration.test.ts'), 'import { createServer } from "node:http"; export const s = createServer;\n');
  writeFileSync(join(mixed, 'tests/test-helper.ts'), 'export function makeUser() { return { id: "u1" }; }\n');
  writeFileSync(join(mixed, 'tests/mixed-split.test.ts'), 'export const hybrid = true;\n');
  writeFileSync(join(mixed, 'e2e/checkout.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('ok', async ({ page }) => { await page.goto('/'); });\n");
  writeFileSync(join(mixed, 'e2e/driver.ts'), "import type { Page } from '@playwright/test';\nimport { expect } from '@playwright/test';\nexport const check = (p: Page) => expect(p).toBeTruthy();\n");
  writeFileSync(join(mixed, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0 });\n");
}

test('unified file mode previews mixed prod and test roles offline and skips non-Playwright support files live', (t) => {
  const { runCliJson, project } = createCliTestWorkspace(t);
  writeMixedAppFixture(project);

  const dry = runCliJson(['mixed-app', '--dry-run']);
  assert.equal(dry.result.file_count, 8);
  assert.equal(findFileEntry(dry.result, 'mixed-app/playwright.config.ts').status, 'dry_run');
  assert.equal(findFileEntry(dry.result, 'mixed-app/playwright.config.ts').file_role, 'test_support_playwright');
  assert.equal(findFileEntry(dry.result, 'mixed-app/e2e/checkout.spec.ts').file_role, 'test:playwright_auto');
  assert.equal(findFileEntry(dry.result, 'mixed-app/src/calc.test.ts').file_role, 'test:auto');

  const live = runCliJson(['mixed-app'], { openRouterStub: 'pass' });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(findFileEntry(live.result, 'mixed-app/playwright.config.ts').status, 'scored');
  assert.equal(findFileEntry(live.result, 'mixed-app/tests/test-helper.ts').status, 'skipped');
  assert.equal(findFileEntry(live.result, 'mixed-app/tests/mixed-split.test.ts').file_role, 'unit+integration');
});

test('explicit --rubric testing-unit and --rubric playwright narrow file runs to matching test targets only', (t) => {
  const { runCliJson, project } = createCliTestWorkspace(t);
  writeMixedAppFixture(project);

  const explicitUnit = runCliJson(['mixed-app', '--rubric', 'testing-unit'], { openRouterStub: 'pass' });
  assert.equal(explicitUnit.result.file_results?.some((f) => f.file.endsWith('src/calc.ts')), false);
  assert.equal(explicitUnit.result.file_results?.some((f) => f.file.endsWith('src/calc.test.ts')), true);
  assert.deepEqual(Object.keys(explicitUnit.result.rubric_groups), ['testing-unit']);

  const explicitPw = runCliJson(['mixed-app', '--rubric', 'playwright'], { openRouterStub: 'pass' });
  assert.deepEqual(
    explicitPw.result.file_results?.filter((f) => f.status === 'scored').map((f) => f.file),
    ['mixed-app/e2e/checkout.spec.ts', 'mixed-app/e2e/driver.ts', 'mixed-app/playwright.config.ts'],
  );
});

test('module mode lints test-only e2e directories against Playwright module checks', (t) => {
  const { runCliJson, root, project } = createCliTestWorkspace(t);
  const e2eDir = join(project, 'e2e');
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(join(e2eDir, 'login.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('login', async ({ page }) => { await page.goto('/login'); });\n");
  writeFileSync(join(e2eDir, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ forbidOnly: !!process.env.CI });\n");

  const e2eOut = join(root, 'e2e-mod-live');
  const e2eLive = runCliJson(['module', 'e2e', '--out', e2eOut], { openRouterStub: 'pass' });

  assert.equal(e2eLive.status, 0, e2eLive.stderr);
  assert.equal('playwright_domain_readable_specs' in (e2eLive.result.quality?.checks ?? {}), true);
  assert.equal('playwright_suite_and_config_diagnostics' in (e2eLive.result.quality?.checks ?? {}), true);
  assert.equal('resilient_user_visible_locators' in (e2eLive.result.quality?.checks ?? {}), false);
  const e2eReq = readSavedRequest(join(e2eOut, 'request.json'));
  assert.equal('login.spec.ts' in (e2eReq.state.test_files ?? {}), true);
  assert.equal(e2eReq.state.production_files_context, undefined);
});

test('module mode attaches production_files_context within 128 KiB and omits it when combined size exceeds 128 KiB', (t) => {
  const { runCliJson, root, project } = createCliTestWorkspace(t);
  const feature = join(project, 'billing-mod');
  mkdirSync(feature, { recursive: true });
  writeFileSync(join(feature, 'invoice.ts'), 'export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n');
  writeFileSync(join(feature, 'invoice.test.ts'), 'import { total } from "./invoice"; if (total([1, 2]) !== 3) throw new Error();\n');
  writeFileSync(join(project, 'AGENTS.md'), '# Repo Conventions\nKeep pure helpers deterministic.\n');

  const mixedOut = join(root, 'mixed-mod-live');
  const mixed = runCliJson(['module', 'billing-mod', '--out', mixedOut], { openRouterStub: 'pass' });
  assert.equal(mixed.status, 0, mixed.stderr);
  const prodReq = readSavedRequest(join(mixedOut, 'request.json'));
  const testReq = readSavedRequest(join(mixedOut, 'test-request.json'));
  assert.equal('follows_repo_conventions' in prodReq.questions, true);
  assert.equal('invoice.ts' in (testReq.state.production_files_context ?? {}), true);
  assert.equal('follows_repo_conventions' in testReq.questions, false);

  const bigMod = join(project, 'big-mod');
  mkdirSync(bigMod, { recursive: true });
  const chunk = 'export const data = "0123456789abcdef";\n'.repeat(1800);
  writeFileSync(join(bigMod, 'core.ts'), chunk);
  writeFileSync(join(bigMod, 'core.test.ts'), chunk);
  const bigOut = join(root, 'big-mod-out');
  assert.equal(runCliJson(['module', 'big-mod', '--out', bigOut], { openRouterStub: 'pass' }).status, 0);
  assert.equal(readSavedRequest(join(bigOut, 'test-request.json')).state.production_files_context, undefined);
});

test('codex CLI backend scores on 0-100 threshold parity, supports --model, and exits 2 on CLI failure', (t) => {
  const { runCli, runCliJson, root } = createCliTestWorkspace(t);
  const fakeBin = join(root, 'fake-codex-bin');
  mkdirSync(fakeBin, { recursive: true });
  writeExecutableScript(join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const schemaIdx = args.indexOf('--output-schema');
if (args[0] !== 'exec' || outIdx === -1 || schemaIdx === -1) process.exit(2);
const ids = JSON.parse(fs.readFileSync(args[schemaIdx + 1], 'utf8')).properties.checks.items.properties.id.enum;
fs.writeFileSync(args[outIdx + 1], JSON.stringify({
  checks: ids.map((id) => ({ id, note: 'Checked.', score: id === 'direct_readability' ? 72 : 65 })),
}));
`);
  const env = { PATH: `${fakeBin}:${process.env.PATH ?? ''}` };

  const codexProc = runCli(['module', 'booking', '--rubric', 'readability', '--backend', 'codex'], { extraEnv: env });
  assert.equal(codexProc.status, 0, codexProc.stderr);
  assert.match(codexProc.stdout, /warning\s+direct_readability\s+\(score 72\/100, pass >= 80\)/);
  assert.doesNotMatch(codexProc.stdout, /named_domain_expressions/);
  assert.equal(runCli(['module', 'booking', '--rubric', 'readability', '--backend', 'codex', '--fail-on-warning'], { extraEnv: env }).status, 1);
  assert.equal(runCliJson(['booking', '--backend', 'codex', '--model', 'gpt-6.2-sol', '--dry-run']).result.requested_model, 'gpt-6.2-sol');
  assert.equal(runCli(['booking', '--backend', 'codex', '--deep', '--dry-run']).status, 2);

  const failingBin = join(root, 'failing-codex-bin');
  mkdirSync(failingBin, { recursive: true });
  writeExecutableScript(join(failingBin, 'codex'), '#!/usr/bin/env node\nconsole.error("auth expired");\nprocess.exit(1);\n');
  const cliErr = runCliJson(['module', 'booking', '--rubric', 'readability', '--backend', 'codex'], {
    extraEnv: { PATH: `${failingBin}:${process.env.PATH ?? ''}` },
  });
  assert.equal(cliErr.status, 2);
  assert.equal(cliErr.result.status, 'error');
});

test('claude CLI backend isolates workspace context, enforces 0-100 parity, and supports --deep and --model', (t) => {
  const { runCli, runCliJson, root, project } = createCliTestWorkspace(t);
  const fakeBin = join(root, 'fake-claude-bin');
  mkdirSync(fakeBin, { recursive: true });
  writeExecutableScript(join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const flagVal = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
if (args[0] !== '-p' || args.includes('--bare') || !args.includes('--restricted')) process.exit(10);
if (flagVal('--effort') !== 'low' || flagVal('--setting-sources') !== '' || flagVal('--tools') !== '') process.exit(11);
if (process.env.MAX_THINKING_TOKENS !== '0' || process.cwd() === ${JSON.stringify(project)}) process.exit(12);
const ids = JSON.parse(flagVal('--json-schema')).properties.checks.items.properties.id.enum;
const model = flagVal('--model');
console.log(JSON.stringify({
  modelUsage: { ['claude-' + model + '-test']: { inputTokens: 10 } },
  structured_output: { checks: ids.map((id) => ({ id, note: 'Checked.', score: id === 'direct_readability' ? 92 : 55 })) },
}));
`);
  const env = { PATH: `${fakeBin}:${process.env.PATH ?? ''}` };

  const claudeRun = runCliJson(['booking', '--rubric', 'readability', '--backend', 'claude', '--concurrency', '2'], { extraEnv: env });
  assert.equal(claudeRun.status, 1, claudeRun.stderr);
  assert.equal(claudeRun.result.requested_model, 'haiku');
  assert.equal(claudeRun.result.returned_model, 'claude-haiku-test');
  assert.equal(claudeRun.result.quality?.checks.named_domain_expressions.severity, 'error');
  assert.equal(runCliJson(['module', 'booking', '--rubric', 'readability', '--backend', 'claude', '--deep'], { extraEnv: env }).result.returned_model, 'claude-sonnet-test');
  assert.equal(runCliJson(['structure', 'booking', '--backend', 'claude', '--deep', '--dry-run']).result.requested_model, 'sonnet');
  assert.equal(runCliJson(['booking', '--backend', 'claude', '--model', 'opus', '--dry-run']).result.requested_model, 'opus');
  assert.equal(runCli(['booking', '--backend', 'claude', '--deep', '--model', 'opus', '--dry-run']).status, 2);
});

test('claude and codex CLI backends run Stage 1 test_kind classification on haiku and gpt-6-luna under --deep', (t) => {
  const { runCliJson, root, project } = createCliTestWorkspace(t);
  const fakeBin = join(root, 'fake-stage1-bin');
  mkdirSync(fakeBin, { recursive: true });
  const suite = join(project, 'cli-tests');
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(join(suite, 'math.test.ts'), 'import { add } from "./math"; if (add(1, 2) !== 3) throw new Error();\n');

  const claudeLog = join(root, 'claude-calls.jsonl');
  writeExecutableScript(join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
process.stdin.resume();
process.stdin.on('end', () => {
  const isClassify = Boolean(schema.properties && schema.properties.test_kind);
  fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ model, isClassify }) + '\\n');
  const structured_output = isClassify
    ? { test_kind: 'unit', reason: 'In-memory unit test.' }
    : { checks: schema.properties.checks.items.properties.id.enum.map((id) => ({ id, note: 'Clean.', score: 92 })) };
  console.log(JSON.stringify({ type: 'result', is_error: false, model, structured_output }));
});
`);

  const codexLog = join(root, 'codex-calls.jsonl');
  writeExecutableScript(join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('-m') + 1];
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
const outPath = args[args.indexOf('-o') + 1];
const isClassify = Boolean(schema.properties && schema.properties.test_kind);
fs.appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify({ model, isClassify }) + '\\n');
const output = isClassify
  ? { test_kind: 'unit', reason: 'In-memory unit test.' }
  : { checks: schema.properties.checks.items.properties.id.enum.map((id) => ({ id, note: 'Clean.', score: 91 })) };
fs.writeFileSync(outPath, JSON.stringify(output));
`);

  const pathEnv = { PATH: `${fakeBin}:${process.env.PATH ?? ''}` };

  const claudeRun = runCliJson(['cli-tests', '--backend', 'claude', '--deep'], { extraEnv: pathEnv });
  assert.equal(claudeRun.status, 0, claudeRun.stderr);
  const claudeCalls = readFileSync(claudeLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { model: string; isClassify: boolean });
  assert.deepEqual(claudeCalls.filter((c) => c.isClassify).map((c) => c.model), ['haiku']);
  assert.equal(claudeCalls.filter((c) => !c.isClassify).every((c) => c.model === 'sonnet'), true);
  assert.equal(findFileEntry(claudeRun.result, 'cli-tests/math.test.ts').file_role, 'unit');

  const codexRun = runCliJson(['cli-tests', '--backend', 'codex'], { extraEnv: pathEnv });
  assert.equal(codexRun.status, 0, codexRun.stderr);
  const codexCalls = readFileSync(codexLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { model: string; isClassify: boolean });
  assert.deepEqual(codexCalls.filter((c) => c.isClassify).map((c) => c.model), ['gpt-6-luna']);
  assert.equal('unit_single_behavior_aaa' in (codexRun.result.quality?.checks ?? {}), true);
});
