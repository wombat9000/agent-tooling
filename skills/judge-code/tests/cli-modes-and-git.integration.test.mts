// End-to-end integration tests running the real installed judge-code CLI subprocess;
// only the external OpenRouter HTTP endpoint is stubbed via openRouterStub.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { JudgeResult } from '../scripts/engine/types.mts';
import {
  createCliTestWorkspace,
  findFileEntry,
  findModuleEntry,
  readSavedJson,
  readSavedRequest,
  runGitCommand,
} from './helpers/cli-harness.mts';

test('auto-discovers AGENTS.md in file and module modes while ignoring .judge-code.json', (t) => {
  const { runCli, runCliJson, root, project, source } = createCliTestWorkspace(t);
  writeFileSync(join(source, 'booking-test-support.ts'), 'export const helper = true;\n');
  writeFileSync(join(project, 'AGENTS.md'), '# Project Rules\nUse explicit Result types.\n');
  writeFileSync(join(project, '.judge-code.json'), JSON.stringify({
    ignore: ['Booking.kt'],
    exclude: ['direct_readability'],
    conventions: false,
  }));

  const out = join(root, 'auto-agents');
  const autoRun = runCliJson(['booking', '--out', out, '--dry-run']);
  assert.equal(autoRun.status, 0, autoRun.stderr);
  assert.equal(autoRun.result.ignored_patterns, undefined);
  assert.equal(autoRun.result.excluded_checks, undefined);
  const bookingReq = readSavedRequest(join(out, findFileEntry(autoRun.result, 'booking/Booking.kt').result_dir!, 'request.json'));
  assert.match(bookingReq.state.conventions ?? '', /Use explicit Result types/);
  assert.match(bookingReq.questions.direct_readability.instructions, /state\.conventions takes precedence/);

  const modOut = join(root, 'mod-agents');
  assert.equal(runCliJson(['module', 'booking', '--out', modOut, '--dry-run']).status, 0);
  const modReq = readSavedRequest(join(modOut, 'request.json'));
  assert.equal('follows_repo_conventions' in modReq.questions, true);

  assert.equal(runCli(['booking', '--config', '.judge-code.json', '--dry-run']).status, 2);
});

test('--conventions, --no-conventions, --ignore, and --exclude customize runs and reject conflicting flags', (t) => {
  const { runCli, runCliJson, root, project, source } = createCliTestWorkspace(t);
  writeFileSync(join(source, 'booking-test-support.ts'), 'export const helper = true;\n');
  writeFileSync(join(project, 'AGENTS.md'), '# Project Rules\nUse explicit Result types.\n');

  const custom = runCliJson([
    'booking',
    '--ignore', '*-test-support.*',
    '--ignore', 'env.ts',
    '--exclude', 'no_comment_deodorant_or_dead_code',
    '--exclude', 'immutable_state',
    '--dry-run',
  ]);
  assert.deepEqual(custom.result.ignored_patterns, ['*-test-support.*', 'env.ts']);
  assert.deepEqual(custom.result.excluded_checks, ['no_comment_deodorant_or_dead_code', 'immutable_state']);
  assert.equal(custom.result.file_results?.some((f) => f.file.endsWith('env.ts')), false);
  assert.equal(custom.result.file_results?.some((f) => f.file.includes('booking-test-support.ts')), false);

  const noConvOut = join(root, 'no-conv');
  const noConv = runCliJson(['booking/Booking.kt', '--no-conventions', '--out', noConvOut, '--dry-run']);
  assert.equal(readSavedRequest(join(noConvOut, findFileEntry(noConv.result, 'booking/Booking.kt').result_dir!, 'request.json')).state.conventions, undefined);

  const overrideOut = join(root, 'override-conv');
  const overrideProc = runCliJson(['booking/Booking.kt', '--conventions', 'conventions.md', '--out', overrideOut, '--dry-run']);
  assert.match(
    readSavedRequest(join(overrideOut, findFileEntry(overrideProc.result, 'booking/Booking.kt').result_dir!, 'request.json')).state.conventions ?? '',
    /mutable JPA entities/,
  );

  assert.equal(runCli(['booking', '--conventions', 'conventions.md', '--no-conventions', '--dry-run']).status, 2);
});

test('--changed resolves committed, working-tree, and untracked files vs main, supports ref/path filters, and exits 0 when clean', (t) => {
  const { runCliJson, root } = createCliTestWorkspace(t);
  const gitRepo = join(root, 'git-repo');
  mkdirSync(join(gitRepo, 'src/a'), { recursive: true });
  mkdirSync(join(gitRepo, 'src/b'), { recursive: true });
  runGitCommand(gitRepo, ['init', '-b', 'main']);
  runGitCommand(gitRepo, ['config', 'user.email', 'test@example.com']);
  runGitCommand(gitRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(gitRepo, 'src/a/one.ts'), 'export const one = 1;\n');
  writeFileSync(join(gitRepo, 'src/b/two.ts'), 'export const two = 2;\n');
  runGitCommand(gitRepo, ['add', '.']);
  runGitCommand(gitRepo, ['commit', '-m', 'Initial commit']);

  const clean = runCliJson(['--changed'], { cwd: gitRepo });
  assert.equal(clean.status, 0);
  assert.equal(clean.result.file_count, 0);

  runGitCommand(gitRepo, ['checkout', '-b', 'feat/demo']);
  writeFileSync(join(gitRepo, 'src/a/one.ts'), 'export const one = 10;\n');
  runGitCommand(gitRepo, ['add', 'src/a/one.ts']);
  runGitCommand(gitRepo, ['commit', '-m', 'Update one']);
  writeFileSync(join(gitRepo, 'src/b/new-file.ts'), 'export const added = true;\n');
  writeFileSync(join(gitRepo, 'src/b/new-file.test.ts'), 'export const t = true;\n');

  assert.deepEqual(
    runCliJson(['--changed', '--dry-run'], { cwd: gitRepo }).result.file_results?.map((f) => f.file),
    ['src/a/one.ts', 'src/b/new-file.test.ts', 'src/b/new-file.ts'],
  );
  assert.deepEqual(
    runCliJson(['--changed', 'HEAD', '--dry-run'], { cwd: gitRepo }).result.file_results?.map((f) => f.file),
    ['src/b/new-file.test.ts', 'src/b/new-file.ts'],
  );
  assert.deepEqual(
    runCliJson(['--changed=HEAD', '--dry-run'], { cwd: gitRepo }).result.file_results?.map((f) => f.file),
    ['src/b/new-file.test.ts', 'src/b/new-file.ts'],
  );
  assert.deepEqual(
    runCliJson(['--changed', 'src/a', '--dry-run'], { cwd: gitRepo }).result.file_results?.map((f) => f.file),
    ['src/a/one.ts'],
  );
});

test('--changed falls back to HEAD without main and rejects unknown refs, non-git dirs, or module mode', (t) => {
  const { runCli, runCliJson, root } = createCliTestWorkspace(t);
  const trunkRepo = join(root, 'trunk-repo');
  mkdirSync(join(trunkRepo, 'src'), { recursive: true });
  runGitCommand(trunkRepo, ['init', '-b', 'trunk']);
  runGitCommand(trunkRepo, ['config', 'user.email', 'test@example.com']);
  runGitCommand(trunkRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(trunkRepo, 'src/core.ts'), 'export const x = 1;\n');
  runGitCommand(trunkRepo, ['add', '.']);
  runGitCommand(trunkRepo, ['commit', '-m', 'Initial']);
  writeFileSync(join(trunkRepo, 'src/core.ts'), 'export const x = 2;\n');

  const fallback = runCliJson(['--changed', '--dry-run'], { cwd: trunkRepo });
  assert.deepEqual(fallback.result.file_results?.map((f) => f.file), ['src/core.ts']);

  assert.equal(runCli(['--changed', 'does-not-exist-ref', '--dry-run'], { cwd: trunkRepo }).status, 2);
  assert.equal(runCli(['--changed', '--dry-run']).status, 2);
  assert.equal(runCli(['module', '--changed', '--dry-run'], { cwd: trunkRepo }).status, 2);
});

test('module subcommand scores single and multi-directory bundles with d1.2-ultra and formats conventions findings', (t) => {
  const { runCli, runCliJson, root, project } = createCliTestWorkspace(t);

  const singleDry = runCliJson(['module', 'booking', '--dry-run']);
  assert.equal(singleDry.result.mode, 'code');
  assert.equal(singleDry.result.requested_model, 'liquid/d1.2-ultra');
  assert.equal(singleDry.result.file_count, 7);

  const liveProc = runCli(['module', 'booking', '--rubric', 'readability', '--rubric', 'module-design'], { openRouterStub: 'scored' });
  assert.equal(liveProc.status, 1, liveProc.stderr);
  assert.match(liveProc.stdout, /booking\n\s+error\s+direct_readability\s+\(score 20\/100, pass >= 80\)\n\s+error\s+modular_organization\s+\(score 20\/100, pass >= 80\)\n\s+warning\s+no_unnecessary_abstraction\s+\(score 65\/100, pass >= 80\)/);
  assert.match(liveProc.stdout, /✖ 2 errors, 1 warning across 1 module \(4 files\)/);

  const convProc = runCli(
    ['module', 'booking', '--rubric', 'readability', '--conventions', 'conventions.md'],
    { openRouterStub: 'conventions-fail' },
  );
  assert.equal(convProc.status, 1);
  assert.match(convProc.stdout, /Rule criteria:\n\s+follows_repo_conventions \(conventions, module, >=80\)/);

  const featA = join(project, 'features/auth');
  const featB = join(project, 'features/billing');
  mkdirSync(featA, { recursive: true });
  mkdirSync(featB, { recursive: true });
  writeFileSync(join(featA, 'login.ts'), 'export const login = () => true;\n');
  writeFileSync(join(featB, 'charge.ts'), 'export const charge = () => 1;\n');

  const multiOut = join(root, 'mod-multi');
  const multiProc = runCli(
    ['module', 'features/auth', 'features/billing', '--rubric', 'module-design', '--out', multiOut],
    { openRouterStub: 'scored' },
  );
  assert.equal(multiProc.status, 1);
  assert.match(multiProc.stdout, /✖ 2 errors, 2 warnings across 2 of 2 modules/);
  const savedMulti = readSavedJson<JudgeResult>(join(multiOut, 'result.json'));
  assert.equal(existsSync(join(multiOut, findModuleEntry(savedMulti, 'features/auth').result_dir!, 'request.json')), true);
});

test('--rule narrows checks and rejects module-scoped rules in file mode or missing module paths', (t) => {
  const { runCli, runCliJson } = createCliTestWorkspace(t);

  assert.deepEqual(
    Object.values(runCliJson(['booking', '--rule', 'direct_readability', '--dry-run']).result.rubric_groups).flat(),
    ['direct_readability'],
  );
  assert.equal(runCli(['booking', '--rule', 'dependency_inversion', '--dry-run']).status, 2);
  assert.deepEqual(
    Object.values(runCliJson(['module', 'booking', '--rule', 'dependency_inversion', '--dry-run']).result.rubric_groups).flat(),
    ['dependency_inversion'],
  );
  assert.equal(runCli(['module', '--dry-run']).status, 2);
});

test('structure subcommand builds compact manifest with .server/.client and formats live structure findings', (t) => {
  const { runCli, runCliJson, root, project } = createCliTestWorkspace(t);
  const feature = join(project, 'onboarding');
  mkdirSync(join(feature, '.server'), { recursive: true });
  mkdirSync(join(feature, 'components'), { recursive: true });
  writeFileSync(join(feature, '.server/decisions.ts'), "import { loadState } from './firestore';\nimport { z } from 'zod';\nexport interface Decision {}\nexport function evaluateDecisions() { return loadState(z); }\n");
  writeFileSync(join(feature, '.server/firestore.ts'), "import { Firestore } from '@google-cloud/firestore';\nexport function loadState(x: unknown) { return [Firestore, x]; }\n");
  writeFileSync(join(feature, '.server/decisions.test.ts'), "import { evaluateDecisions } from './decisions';\nconsole.log(evaluateDecisions);\n");
  writeFileSync(join(feature, 'components/language-picker.tsx'), "import { LanguageChip } from './language-chip';\nexport function LanguagePicker() { return LanguageChip; }\n");
  writeFileSync(join(feature, 'components/language-chip.tsx'), 'export const LanguageChip = () => null;\n');
  writeFileSync(join(feature, '.server/data.json'), '{"ok":true}\n');

  const out = join(root, 'structure-preview');
  const dry = runCliJson(['structure', 'onboarding', '--out', out, '--dry-run']);
  assert.equal(dry.result.mode, 'structure');
  assert.equal(dry.result.rubric, 'integration-readiness-structure-v1+project-structure-v1');
  assert.equal(dry.result.file_count, 6);

  const manifest = readSavedRequest(join(out, 'request.json')).state.project_structure!;
  assert.deepEqual(manifest.directory_summary['.server'], { source_files: 2, test_files: 1, other_files: 1, subdirs: 0 });
  assert.deepEqual(manifest.files['.server/decisions.ts'].exports, ['Decision', 'evaluateDecisions']);
  assert.deepEqual(manifest.files['.server/decisions.test.ts'], { kind: 'test' });

  const liveStruct = runCli(['structure', 'onboarding'], { openRouterStub: 'scored' });
  assert.equal(liveStruct.status, 1);
  assert.match(liveStruct.stdout, /✖ 1 error, 0 warnings across structure \(6 files\)/);
});

test('structure subcommand rejects mismatched rubrics, file targets, and oversize >128 KiB manifests', (t) => {
  const { runCli, project } = createCliTestWorkspace(t);
  const feature = join(project, 'onboarding');
  mkdirSync(feature, { recursive: true });
  writeFileSync(join(feature, 'app.ts'), 'export const ok = true;\n');

  assert.equal(runCli(['onboarding', '--rubric', 'project-structure', '--dry-run']).status, 2);
  assert.equal(runCli(['structure', 'onboarding', '--rubric', 'readability', '--dry-run']).status, 2);
  assert.equal(runCli(['structure', 'onboarding/app.ts', '--dry-run']).status, 2);

  const hugeRepo = join(project, 'oversize-structure');
  const richBody = [
    "import { alpha, beta, gamma } from './common-shared-domain-primitives';",
    "import { delta, epsilon, zeta } from '../shared/persistence-repository-client';",
    "import { z } from 'zod';",
    ...Array.from({ length: 10 }, (_, idx) => `export function exportedHandlerOperationName${idx}() { return ${idx}; }`),
  ].join('\n');
  for (let i = 0; i < 450; i += 1) {
    const dir = join(hugeRepo, `modules/domain-slice-${String(i).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `workflow-orchestrator-controller-${i}.ts`), richBody);
  }
  const oversizeProc = runCli(['structure', 'oversize-structure', '--dry-run']);
  assert.equal(oversizeProc.status, 2);
  assert.match(
    oversizeProc.stderr,
    /Structural manifest exceeds 128 KiB \(\d+ \/ 131072 bytes; 450 files: 450 source, 0 test, 0 other\)\./,
  );
});

test('react rubric activates only on matching files and modules and skips non-React targets with zero API calls', (t) => {
  const { runCli, runCliJson, root, project } = createCliTestWorkspace(t);
  const webFeature = join(project, 'web-feature');
  mkdirSync(join(webFeature, '.server'), { recursive: true });
  writeFileSync(join(webFeature, '.server/session.ts'), 'export function readSession() { return { ok: true }; }\n');
  writeFileSync(join(webFeature, 'types.ts'), "import type { ReactNode } from 'react';\nexport interface Props { children?: ReactNode; }\n");
  writeFileSync(join(webFeature, 'use-counter.ts'), "import { useState } from 'react';\nexport function useCounter() { return useState(0); }\n");
  writeFileSync(join(webFeature, 'CounterCard.tsx'), 'export function CounterCard() { return <div>Counter</div>; }\n');

  const serverOnly = join(project, 'server-only');
  mkdirSync(serverOnly, { recursive: true });
  writeFileSync(join(serverOnly, 'http.ts'), 'export function ok() { return new Response("ok"); }\n');
  writeFileSync(join(serverOnly, 'db.ts'), 'export const TABLE = "users";\n');

  const mixedReactLive = runCliJson(['web-feature', '--rubric', 'react'], { openRouterStub: 'pass' });
  assert.deepEqual(
    mixedReactLive.result.file_results?.filter((f) => f.status === 'scored').map((f) => f.file),
    ['web-feature/CounterCard.tsx', 'web-feature/use-counter.ts'],
  );
  assert.deepEqual(
    mixedReactLive.result.file_results?.filter((f) => f.status === 'skipped').map((f) => f.file),
    ['web-feature/.server/session.ts', 'web-feature/types.ts'],
  );

  const serverFile = runCli(['server-only', '--rubric', 'react']);
  assert.equal(serverFile.status, 0);
  assert.match(serverFile.stdout, /0 applicable files \(2 skipped: not applicable\)/);

  const serverMod = runCli(['module', 'server-only', '--rubric', 'react']);
  assert.equal(serverMod.status, 0);
  assert.match(serverMod.stdout, /0 applicable modules \(1 skipped: not applicable; 2 files\)/);

  const multiModOut = join(root, 'multi-mod-react');
  const multiMod = runCliJson(['module', 'web-feature', 'server-only', '--rubric', 'react', '--out', multiModOut], { openRouterStub: 'pass' });
  assert.equal(findModuleEntry(multiMod.result, 'web-feature').status, 'scored');
  assert.equal(findModuleEntry(multiMod.result, 'server-only').status, 'skipped');
  assert.equal(
    'react_state_authority' in readSavedRequest(join(multiModOut, findModuleEntry(multiMod.result, 'web-feature').result_dir!, 'request.json')).questions,
    true,
  );
});
