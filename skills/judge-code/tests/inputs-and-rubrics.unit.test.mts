import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isTestOrSupportPath } from '../scripts/inputs/classify-path.mts';
import { containsSensitiveCredential } from '../scripts/inputs/credentials.mts';
import { readInputs, readPerFileInputs } from '../scripts/inputs/files.mts';
import { compileIgnoreMatcher } from '../scripts/inputs/ignore.mts';
import { filterRubricForFiles, hasRuntimeImport, matchesFileApplicability } from '../scripts/rubrics/applicability.mts';
import {
  CLASSIFIER_OPENROUTER_MODEL,
  classifyTestFile,
  detectPlaywrightSignals,
  extractActiveKinds,
  formatTestFileRole,
  parseCliTestKind,
  parseOpenRouterTestKind,
  routeTestBundleRubrics,
  routeTestRubrics,
} from '../scripts/rubrics/classifier.mts';
import { candidateModulePaths, findAncestorPlaywrightConfig } from '../scripts/rubrics/playwright-detect.mts';
import { resolveRubrics } from '../scripts/rubrics/resolver.mts';

test('isTestOrSupportPath classifies universal test and support paths as true and production paths as false', () => {
  const cases: Array<[string, boolean]> = [
    ['test/helper.ts', true],
    ['tests/Fixture.kt', true],
    ['testing/fakes.ts', true],
    ['__tests__/widget.tsx', true],
    ['__mocks__/api.ts', true],
    ['testFixtures/BookingBuilder.kt', true],
    ['src/test/kotlin/com/app/testsupport/Fake.kt', true],
    ['src/test-support/helper.ts', true],
    ['app/features/jobs/.server/test-support.ts', true],
    ['app/features/jobs/overview.test-support.ts', true],
    ['app/features/auth/auth_test_support.ts', true],
    ['ServiceIdentityFeatureTestSupport.kt', true],
    ['booking.test.ts', true],
    ['booking.spec.tsx', true],
    ['client.mock.ts', true],
    ['handler_test.ts', true],
    ['BookingTest.kt', true],
    ['conftest.py', true],
    ['test_booking.py', true],
    ['Booking.kt', false],
    ['latest.ts', false],
    ['.server/decisions.ts', false],
    ['.client/widget.tsx', false],
    ['booking-test-support.ts', false],
  ];

  for (const [path, expected] of cases) {
    assert.equal(isTestOrSupportPath(path), expected, `Unexpected classification for ${path}`);
  }
});

test('compileIgnoreMatcher matches basename globs, path globs, brace groups, and directory-only rules', () => {
  const matcher = compileIgnoreMatcher(['*-test-support.*', 'legacy/**', '**/gen/**', '**/*.pb.{ts,kt}', 'scratch/']);

  assert.equal(matcher.isIgnoredFile('app/lib/booking-test-support.kt'), true);
  assert.equal(matcher.isIgnoredFile('legacy/sub/older.ts'), true);
  assert.equal(matcher.isIgnoredDir('a/b/gen'), true);
  assert.equal(matcher.isIgnoredFile('api/v1/schema.pb.ts'), true);
  assert.equal(matcher.isIgnoredFile('nested/scratch/tmp.ts'), true);
  assert.equal(matcher.isIgnoredFile('scratch'), false);
});

test('compileIgnoreMatcher rejects blank ignore patterns', () => {
  assert.throws(() => compileIgnoreMatcher(['   ']), /Invalid --ignore pattern/);
});

test('matchesFileApplicability activates on matching extensions and runtime imports while ignoring type-only or commented imports', () => {
  const reactRule = { extensions: ['.tsx'], runtime_imports: ['react', 'react-dom'] };
  const cases: Array<[string, string, boolean]> = [
    ['App.tsx', 'export const App = () => <div />;', true],
    ['useProfile.ts', "import { useState } from 'react';\nexport const x = useState;", true],
    ['useProfile.mts', 'import React from "react";\nexport const x = React;', true],
    ['runtime.cts', "import { jsx } from 'react/jsx-runtime';\nexport const x = jsx;", true],
    ['hydrate.ts', "import { createRoot } from 'react-dom/client';\nexport const x = createRoot;", true],
    ['mixed.ts', "import { useEffect, type ReactNode } from 'react';\nexport const x = useEffect;", true],
    ['default-plus-type.ts', "import React, { type FC } from 'react';\nexport const x = React;", true],
    ['side-effect.ts', "import 'react-dom';\n", true],
    ['types.ts', "import type { ReactNode } from 'react';\nexport type Child = ReactNode;", false],
    ['inline-types.ts', "import { type ReactNode, type RefObject } from 'react';\nexport type R = RefObject<HTMLDivElement>;", false],
    ['import-type-expr.ts', "export type Node = import('react').ReactNode;\n", false],
    ['commented.ts', "// import { useState } from 'react';\n/* import React from 'react'; */\nexport const x = 1;", false],
    ['template.ts', "export const doc = `\nimport { useState } from 'react';\n`;\n", false],
    ['router.ts', "import { redirect } from 'react-router';\nexport const r = redirect;", false],
    ['side-then-type.ts', "import './setup';\nimport type { ReactNode } from 'react';\nexport type T = ReactNode;", false],
    ['Service.kt', "import { useState } from 'react'\nclass Service", false],
  ];

  for (const [file, content, expected] of cases) {
    assert.equal(matchesFileApplicability(file, content, reactRule), expected, `Unexpected match for ${file}`);
  }
  assert.equal(hasRuntimeImport('export const plain = 1;\n', ['react']), false);
});

test('detectPlaywrightSignals identifies playwright configs and runtime imports deterministically', () => {
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'playwright.config.ts', content: 'export default {};' }),
    { isPlaywright: true, isPlaywrightConfig: true },
  );
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'e2e/login.spec.ts', content: "import { test, expect } from '@playwright/test';\n" }),
    { isPlaywright: true, isPlaywrightConfig: false },
  );
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'e2e/cypress.spec.ts', content: "cy.visit('/login');\n" }),
    { isPlaywright: false, isPlaywrightConfig: false },
  );
});

test('classifyTestFile short-circuits playwright.config.* in Stage 0 with zero API calls', async () => {
  let apiCalls = 0;

  const classification = await classifyTestFile({
    filePath: 'playwright.config.ts',
    content: 'export default { retries: 0 };',
    invokeOpenRouter: async () => {
      apiCalls += 1;
      throw new Error('Stage 0 config should not invoke OpenRouter');
    },
  });

  assert.equal(apiCalls, 0);
  assert.equal(classification.primary, 'test_support');
  assert.equal(classification.isPlaywrightConfig, true);
  assert.equal(classification.fileRole, 'test_support_playwright');
});

test('routeTestRubrics routes playwright.config.* to config diagnostics in both file and module modes', () => {
  const configClassification = { activeKinds: ['test_support' as const], isPlaywright: true, isPlaywrightConfig: true };
  const fileTestRubric = resolveRubrics({ mode: 'file', target: 'test_code', hasRequirements: false, hasConventions: false });
  const moduleTestRubric = resolveRubrics({ mode: 'code', target: 'test_code', hasRequirements: false, hasConventions: false });

  assert.deepEqual(
    Object.keys(routeTestRubrics(configClassification, fileTestRubric).questions),
    ['playwright_suite_and_config_diagnostics'],
  );
  assert.deepEqual(
    Object.keys(routeTestRubrics(configClassification, moduleTestRubric).questions),
    ['playwright_suite_and_config_diagnostics'],
  );
});

test('detectPlaywrightSignals resolves 1-2 hop transitive fixture imports in bundles and on disk', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-transitive-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'apps/web/e2e/specs'), { recursive: true });
  mkdirSync(join(tmp, 'apps/web/e2e/fixtures'), { recursive: true });

  const baseFixture = "import { test as base, expect } from '@playwright/test';\nexport const test = base;\nexport { expect };\n";
  const hopFixture = "export { test, expect } from './base-fixtures.js';\n";
  const specCode = "import { test, expect } from '../fixtures';\ntest('loads', async ({ page }) => { await expect(page).toHaveTitle(/App/); });\n";
  const typeOnlySpec = "import type { Page } from '../fixtures';\nexport type P = Page;\n";

  writeFileSync(join(tmp, 'apps/web/e2e/fixtures/base-fixtures.ts'), baseFixture);
  writeFileSync(join(tmp, 'apps/web/e2e/fixtures/index.ts'), hopFixture);
  const specPath = join(tmp, 'apps/web/e2e/specs/login.spec.ts');
  writeFileSync(specPath, specCode);

  assert.deepEqual(
    detectPlaywrightSignals(
      { filePath: 'apps/web/e2e/specs/login.spec.ts', content: specCode },
      { absPath: specPath, repoRoot: tmp },
    ),
    { isPlaywright: true, isPlaywrightConfig: false },
  );
  assert.deepEqual(
    detectPlaywrightSignals(
      { filePath: 'apps/web/e2e/specs/types.spec.ts', content: typeOnlySpec },
      { absPath: join(tmp, 'apps/web/e2e/specs/types.spec.ts'), repoRoot: tmp },
    ),
    { isPlaywright: false, isPlaywrightConfig: false },
  );

  // In-memory bundle resolution (no disk paths needed)
  const bundleFiles = {
    'e2e/fixtures.ts': baseFixture,
    'e2e/specs/dashboard.spec.ts': specCode,
  };
  assert.deepEqual(
    detectPlaywrightSignals(
      { filePath: 'e2e/specs/dashboard.spec.ts', content: specCode },
      { bundleFiles },
    ),
    { isPlaywright: true, isPlaywrightConfig: false },
  );

  // filterRubricForFiles must NOT strip playwright-v1 checks for custom-fixture specs
  const pwRubric = resolveRubrics({ mode: 'file', target: 'test_code', rubrics: ['playwright'], hasRequirements: false, hasConventions: false });
  const filtered = filterRubricForFiles(
    pwRubric,
    { 'apps/web/e2e/specs/login.spec.ts': specCode },
    { filePaths: { 'apps/web/e2e/specs/login.spec.ts': specPath }, repoRoot: tmp },
  );
  assert.equal('playwright_web_first_and_race_free' in filtered.questions, true);
  assert.equal('playwright_strict_scoped_locators' in filtered.questions, true);
});

test('candidateModulePaths and detectPlaywrightSignals ignore static assets without ENOTDIR while resolving dotted code stems', (t) => {
  assert.deepEqual(candidateModulePaths('./styles.css'), []);
  assert.deepEqual(candidateModulePaths('./data/regions.json'), []);
  assert.deepEqual(candidateModulePaths('./assets/icon.svg'), []);
  assert.deepEqual(candidateModulePaths('./fonts/inter.woff2'), []);
  assert.equal(candidateModulePaths('./api.session').includes('./api.session.ts'), true);
  assert.equal(candidateModulePaths('./foo.v2').includes('./foo.v2.ts'), true);

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pw-static-assets-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'app/data'), { recursive: true });
  writeFileSync(join(tmp, 'app/styles.css'), '.panel { color: inherit; }\n');
  writeFileSync(join(tmp, 'app/data/regions.json'), '{"regions":[]}\n');
  writeFileSync(
    join(tmp, 'app/api.session.ts'),
    "import { test as base, expect } from '@playwright/test';\nexport const test = base;\nexport { expect };\n",
  );
  writeFileSync(join(tmp, 'app/helper.v2.ts'), 'export const value = 42;\n');

  const pwSpecCode = [
    "import './styles.css';",
    "import regions from './data/regions.json';",
    "import { test, expect } from './api.session';",
    "test('renders', async ({ page }) => { await expect(page).toHaveTitle(String(regions)); });",
    '',
  ].join('\n');
  const nonPwSpecCode = [
    "import './styles.css?inline';",
    "import regions from './data/regions.json';",
    "import { value } from './helper.v2';",
    'export const summary = [regions, value];',
    '',
  ].join('\n');

  const pwSpecPath = join(tmp, 'app/workspace.spec.ts');
  const nonPwSpecPath = join(tmp, 'app/panel.test.tsx');
  writeFileSync(pwSpecPath, pwSpecCode);
  writeFileSync(nonPwSpecPath, nonPwSpecCode);

  // On-disk resolution: zero ENOTDIR crash on real .css/.json files, dotted .ts stem resolves transitively
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'app/workspace.spec.ts', content: pwSpecCode }, { absPath: pwSpecPath, repoRoot: tmp }),
    { isPlaywright: true, isPlaywrightConfig: false },
  );
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'app/panel.test.tsx', content: nonPwSpecCode }, { absPath: nonPwSpecPath, repoRoot: tmp }),
    { isPlaywright: false, isPlaywrightConfig: false },
  );

  // In-memory bundle resolution: same behavior without disk paths
  assert.deepEqual(
    detectPlaywrightSignals(
      { filePath: 'app/workspace.spec.ts', content: pwSpecCode },
      {
        bundleFiles: {
          'app/workspace.spec.ts': pwSpecCode,
          'app/api.session.ts': "import { test as base } from '@playwright/test';\nexport const test = base;\n",
        },
      },
    ),
    { isPlaywright: true, isPlaywrightConfig: false },
  );
  assert.deepEqual(
    detectPlaywrightSignals(
      { filePath: 'app/panel.test.tsx', content: nonPwSpecCode },
      {
        bundleFiles: {
          'app/panel.test.tsx': nonPwSpecCode,
          'app/helper.v2.ts': 'export const value = 42;\n',
        },
      },
    ),
    { isPlaywright: false, isPlaywrightConfig: false },
  );
});

test('readInputs and readPerFileInputs preserve test-root context inside repoRoot without leaking temp ancestor dirs', (t) => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'test-dir-xyz-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const repo = join(outer, 'test', 'my-repo');
  mkdirSync(join(repo, 'src/main/kotlin/com/app'), { recursive: true });
  mkdirSync(join(repo, 'src/test/kotlin/com/app'), { recursive: true });
  writeFileSync(join(repo, 'src/main/kotlin/com/app/App.kt'), 'class App\n');
  writeFileSync(join(repo, 'src/test/kotlin/com/app/Fake.kt'), 'class Fake\n');
  writeFileSync(
    join(repo, 'src/test/kotlin/com/app/Fixture.kt'),
    'private const val API_KEY = "test-api-key"\nprivate const val RESEND_API_KEY = "fixture-api-key"\n',
  );

  // Production file inside /tmp/.../test/my-repo/src/main MUST stay production when repoRoot is my-repo
  const prodLoaded = readPerFileInputs({
    source: join(repo, 'src/main'),
    repoRoot: repo,
    includeProduction: true,
    includeTests: true,
  });
  assert.deepEqual(Object.keys(prodLoaded.files), ['kotlin/com/app/App.kt']);
  assert.deepEqual(Object.keys(prodLoaded.testFiles ?? {}), []);

  // Directory target src/test/kotlin without displayBaseDir (module mode) MUST preserve test-root context and isTestFile=true
  const testLoaded = readInputs({
    source: join(repo, 'src/test/kotlin'),
    repoRoot: repo,
    includeProduction: true,
    includeTests: true,
  });
  assert.deepEqual(Object.keys(testLoaded.files), []);
  assert.deepEqual(Object.keys(testLoaded.testFiles ?? {}).sort(), ['com/app/Fake.kt', 'com/app/Fixture.kt']);
});

test('Stage 0 avoids false positives on e2e Node helpers and Vitest-globals specs while Stage 1 e2e_browser + ancestor playwright.config.* upgrades to e2e_playwright', async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pw-ancestor-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'apps/web/e2e/flows'), { recursive: true });
  mkdirSync(join(tmp, 'apps/web/src'), { recursive: true });
  mkdirSync(join(tmp, 'apps/web/tests'), { recursive: true });
  mkdirSync(join(tmp, 'apps/other/e2e'), { recursive: true });

  writeFileSync(join(tmp, 'apps/web/package.json'), '{"name":"web"}\n');
  writeFileSync(join(tmp, 'apps/web/playwright.config.ts'), 'export default {};\n');
  writeFileSync(join(tmp, 'apps/other/package.json'), '{"name":"other"}\n');
  writeFileSync(join(tmp, 'playwright.config.ts'), 'export default {};\n');

  const nodeStub = join(tmp, 'apps/web/e2e/fake-main-api.mjs');
  const vitestGlobalsSpec = join(tmp, 'apps/web/src/Button.spec.tsx');
  const pathAliasedSpec = join(tmp, 'apps/web/e2e/flows/case.spec.ts');
  const genericE2eTest = join(tmp, 'apps/web/tests/checkout.test.ts');
  const otherAppSpec = join(tmp, 'apps/other/e2e/smoke.spec.ts');
  const stubCode = "import { createServer } from 'node:http';\nexport const server = createServer();\n";
  const globalsSpecCode = "describe('Button', () => { it('renders label', () => { expect(true).toBe(true); }); });\n";
  const aliasedSpecCode = "import { test, expect } from '@app/e2e-fixtures';\ntest('case flow', async ({ page }) => { await page.goto('/'); });\n";
  writeFileSync(nodeStub, stubCode);
  writeFileSync(vitestGlobalsSpec, globalsSpecCode);
  writeFileSync(pathAliasedSpec, aliasedSpecCode);
  writeFileSync(genericE2eTest, "test('checkout', async ({ page }) => { await page.goto('/checkout'); });\n");
  writeFileSync(otherAppSpec, "test('other', async ({ page }) => { await page.goto('/'); });\n");

  assert.equal(findAncestorPlaywrightConfig(join(tmp, 'apps/web/e2e/flows'), { stopDir: tmp }), join(tmp, 'apps/web/playwright.config.ts'));
  // apps/other has package.json without playwright.config.ts -> must NOT leak up to root playwright.config.ts
  assert.equal(findAncestorPlaywrightConfig(join(tmp, 'apps/other/e2e'), { stopDir: tmp }), null);

  // Stage 0 must NOT false-positive on plain Node helpers under e2e/ or Vitest/Jest-globals *.spec.* files
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'apps/web/e2e/fake-main-api.mjs', content: stubCode }, { absPath: nodeStub, repoRoot: tmp }),
    { isPlaywright: false, isPlaywrightConfig: false },
  );
  assert.deepEqual(
    detectPlaywrightSignals({ filePath: 'apps/web/src/Button.spec.tsx', content: globalsSpecCode }, { absPath: vitestGlobalsSpec, repoRoot: tmp }),
    { isPlaywright: false, isPlaywrightConfig: false },
  );

  // Stage 1 test_support on a plain Node stub under e2e/ remains non-Playwright (so it skips cleanly)
  const classifiedStub = await classifyTestFile({
    filePath: 'apps/web/e2e/fake-main-api.mjs',
    content: stubCode,
    detectionContext: { absPath: nodeStub, repoRoot: tmp },
    invokeCli: async () => ({ raw: { test_kind: 'test_support', reason: 'HTTP stub server' }, returnedModel: 'stub' }),
  });
  assert.equal(classifiedStub.isPlaywright, false);
  assert.equal(classifiedStub.fileRole, 'test_support');

  // Stage 1 e2e_browser + ancestor playwright.config.* upgrades path-aliased/ambient browser specs to e2e_playwright
  for (const [relPath, absPath, content] of [
    ['apps/web/e2e/flows/case.spec.ts', pathAliasedSpec, aliasedSpecCode],
    ['apps/web/tests/checkout.test.ts', genericE2eTest, "test('checkout', async ({ page }) => { await page.goto('/checkout'); });\n"],
  ] as const) {
    const classified = await classifyTestFile({
      filePath: relPath,
      content,
      detectionContext: { absPath, repoRoot: tmp },
      invokeCli: async () => ({ raw: { test_kind: 'e2e_browser', reason: 'browser journey' }, returnedModel: 'stub' }),
    });
    assert.equal(classified.isPlaywright, true, `Expected e2e_playwright upgrade for ${relPath}`);
    assert.equal(classified.fileRole, 'e2e_playwright');
  }

  // Respects package.json boundary even after Stage 1 e2e_browser
  const classifiedOther = await classifyTestFile({
    filePath: 'apps/other/e2e/smoke.spec.ts',
    content: "test('other', async ({ page }) => { await page.goto('/'); });\n",
    detectionContext: { absPath: otherAppSpec, repoRoot: tmp },
    invokeCli: async () => ({ raw: { test_kind: 'e2e_browser', reason: 'browser journey' }, returnedModel: 'stub' }),
  });
  assert.equal(classifiedOther.isPlaywright, false);
  assert.equal(classifiedOther.fileRole, 'e2e_browser');

  // Vitest Browser Mode / RTL component test under repo with root playwright.config.ts must NOT promote to e2e_playwright
  mkdirSync(join(tmp, 'app/features/about/components'), { recursive: true });
  const vitestBrowserPath = join(tmp, 'app/features/about/components/about-page.browser.test.tsx');
  const vitestBrowserCode = [
    "import { render, screen } from '@testing-library/react';",
    "import { expect, it } from 'vitest';",
    "import { page } from 'vitest/browser';",
    "it('renders about page', async () => { await page.viewport(1280, 900); render(<main />); expect(screen.getByRole('main')).toBeVisible(); });",
    '',
  ].join('\n');
  writeFileSync(vitestBrowserPath, vitestBrowserCode);

  const classifiedVitestSecondary = await classifyTestFile({
    filePath: 'app/features/about/components/about-page.browser.test.tsx',
    content: vitestBrowserCode,
    detectionContext: { absPath: vitestBrowserPath, repoRoot: tmp },
    invokeOpenRouter: async () => ({
      raw: {
        model: 'typesafe/jev-1.14',
        answers: {
          test_kind: {
            type: 'choice',
            choice: 'unit',
            probabilities: { unit: 0.7, integration: 0.02, e2e_browser: 0.25, test_support: 0.02, other: 0.01 },
          },
        },
      },
      retries: 0,
    }),
  });
  assert.equal(classifiedVitestSecondary.isPlaywright, false);
  assert.equal(classifiedVitestSecondary.fileRole, 'unit+e2e_browser');

  const classifiedVitestPrimary = await classifyTestFile({
    filePath: 'app/features/about/components/about-page.browser.test.tsx',
    content: vitestBrowserCode,
    detectionContext: { absPath: vitestBrowserPath, repoRoot: tmp },
    invokeCli: async () => ({ raw: { test_kind: 'e2e_browser', reason: 'browser viewport test' }, returnedModel: 'stub' }),
  });
  assert.equal(classifiedVitestPrimary.isPlaywright, false);
  assert.equal(classifiedVitestPrimary.fileRole, 'e2e_browser');
});

test('containsSensitiveCredential allows obvious synthetic test placeholders in tests while blocking real secrets everywhere', () => {
  const benignTestPlaceholders = [
    "const apiKey = 'local-emulator-api-key';",
    "const key = { api_key: 'e2e-api-key' };",
    "const cfg = { clientSecret: 'dev-only-session-secret-change-me' };",
    "const creds = { password: 'test-password-123' };",
    "const token = { access_token: 'playwright-auth-token' };",
    "const secret = { client_secret: 'fake-secret-value' };",
    "const fixtureKey = { resendApiKey: 'fixture-api-key' };",
    "const fixtureUnderscore = { api_key: 'fixture_api_key' };",
    "const mock = { apiKey: 'mock-api-key-value' };",
    "const stub = { accessToken: 'stub-token-9999' };",
    "const dummy = { password: 'dummy-password' };",
    "const example = { api_key: 'example-api-key-value' };",
    "const underscoreKey = { apiKey: 'test_api_key' };",
    "const underscorePass = { password: 'fake_password_123' };",
    "const underscoreEmu = { api_key: 'local_emulator_api_key' };",
    "const underscoreDev = { client_secret: 'dev_only_session_secret' };",
  ];

  for (const snippet of benignTestPlaceholders) {
    assert.equal(containsSensitiveCredential(snippet, { isTestFile: true }), false, `Should allow in test: ${snippet}`);
    assert.equal(containsSensitiveCredential(snippet, { isTestFile: false }), true, `Should block in prod: ${snippet}`);
  }

  const alwaysBlocked = [
    "const apiKey = '9f8e7d6c5b4a3210fedcba';",
    "const password = 'ProdPassword2026!';",
    "const sk = 'sk-or-v1-1234567890abcdef1234567890abcdef';",
    "const gh = 'ghp_1234567890abcdef1234567890abcdef';",
    "const gcp = 'AIzaSyD-1234567890abcdef1234567890abcde';",
    "const aws = 'AKIA1234567890ABCDEF';",
    "const pem = '-----BEGIN PRIVATE KEY-----\\nabc';",
    "const ok = { apiKey: 'test-api-key' };\nconst leaked = { clientSecret: 'prod-secret-99887766' };",
  ];

  for (const snippet of alwaysBlocked) {
    assert.equal(containsSensitiveCredential(snippet, { isTestFile: true }), true, `Should still block in test: ${snippet}`);
    assert.equal(containsSensitiveCredential(snippet, { isTestFile: false }), true, `Should block in prod: ${snippet}`);
  }
});

test('routeTestRubrics maps each test kind and Playwright flag to its exact Stage 2 check set', () => {
  const fileTestRubric = resolveRubrics({ mode: 'file', target: 'test_code', hasRequirements: false, hasConventions: false });
  const routingCases = [
    {
      classification: { activeKinds: ['unit'] as const, isPlaywright: false, isPlaywrightConfig: false },
      expected: ['disciplined_test_doubles', 'observable_diagnostic_assertions', 'owner_boundary_no_seams', 'unit_single_behavior_aaa'],
    },
    {
      classification: { activeKinds: ['integration'] as const, isPlaywright: false, isPlaywrightConfig: false },
      expected: ['integration_cohesive_scope', 'observable_diagnostic_assertions', 'owner_boundary_no_seams', 'real_internal_wiring'],
    },
    {
      classification: { activeKinds: ['e2e_browser'] as const, isPlaywright: true, isPlaywrightConfig: false },
      expected: [
        'observable_diagnostic_assertions',
        'owner_boundary_no_seams',
        'playwright_honest_app_boundaries',
        'playwright_strict_scoped_locators',
        'playwright_web_first_and_race_free',
      ],
    },
    {
      classification: { activeKinds: ['e2e_browser'] as const, isPlaywright: false, isPlaywrightConfig: false },
      expected: [
        'deterministic_e2e_waiting_and_isolation',
        'focused_user_journeys',
        'observable_diagnostic_assertions',
        'owner_boundary_no_seams',
        'resilient_user_visible_locators',
      ],
    },
    {
      classification: { activeKinds: ['test_support'] as const, isPlaywright: true, isPlaywrightConfig: false },
      expected: ['playwright_strict_scoped_locators', 'playwright_web_first_and_race_free'],
    },
    {
      classification: { activeKinds: ['test_support'] as const, isPlaywright: false, isPlaywrightConfig: false },
      expected: [],
    },
    {
      classification: { activeKinds: ['other'] as const, isPlaywright: false, isPlaywrightConfig: false },
      expected: [],
    },
  ];

  for (const { classification, expected } of routingCases) {
    const routed = Object.keys(
      routeTestRubrics({ ...classification, activeKinds: [...classification.activeKinds] }, fileTestRubric).questions,
    ).sort();
    assert.deepEqual(routed, expected);
  }
});

test('extractActiveKinds activates secondary test kinds at or above 0.20 while ignoring other', () => {
  const probabilities = { unit: 0.72, integration: 0.25, e2e_browser: 0.01, test_support: 0.01, other: 0.01 };

  const activeKinds = extractActiveKinds('unit', probabilities);

  assert.deepEqual(activeKinds, ['unit', 'integration']);
  assert.equal(formatTestFileRole(activeKinds, { isPlaywright: false, isPlaywrightConfig: false }), 'unit+integration');
});

test('routeTestBundleRubrics unions routed checks across classified test files in a module', () => {
  const moduleTestRubric = resolveRubrics({ mode: 'code', target: 'test_code', hasRequirements: false, hasConventions: false });

  const bundleRubric = routeTestBundleRubrics([
    { activeKinds: ['e2e_browser'], isPlaywright: true, isPlaywrightConfig: false },
    { activeKinds: ['test_support'], isPlaywright: true, isPlaywrightConfig: true },
  ], moduleTestRubric);

  assert.equal('playwright_domain_readable_specs' in bundleRubric.questions, true);
  assert.equal('playwright_suite_and_config_diagnostics' in bundleRubric.questions, true);
  assert.equal('independent_requirement_coverage' in bundleRubric.questions, true);
  assert.equal('resilient_user_visible_locators' in bundleRubric.questions, false);
});

test('parseOpenRouterTestKind extracts the primary choice and probabilities from valid responses', () => {
  assert.equal(CLASSIFIER_OPENROUTER_MODEL, 'typesafe/jev-1.14');

  const parsed = parseOpenRouterTestKind({
    model: 'typesafe/jev-1.14',
    answers: {
      test_kind: {
        type: 'choice',
        choice: 'integration',
        probabilities: { unit: 0.05, integration: 0.9, e2e_browser: 0.02, test_support: 0.02, other: 0.01 },
      },
    },
  });

  assert.equal(parsed.primary, 'integration');
  assert.equal(parsed.returnedModel, 'typesafe/jev-1.14');
});

test('parseCliTestKind accepts valid test_kind values and rejects unknown categories', () => {
  const parsed = parseCliTestKind({ test_kind: 'e2e_browser', reason: 'Playwright browser test' });

  assert.equal(parsed.primary, 'e2e_browser');
  assert.throws(() => parseCliTestKind({ test_kind: 'unknown', reason: 'bad' }), /invalid test_kind/);
});
