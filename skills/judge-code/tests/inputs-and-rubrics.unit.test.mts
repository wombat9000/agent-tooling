import assert from 'node:assert/strict';
import test from 'node:test';
import { isTestOrSupportPath } from '../scripts/inputs/classify-path.mts';
import { compileIgnoreMatcher } from '../scripts/inputs/ignore.mts';
import { hasRuntimeImport, matchesFileApplicability } from '../scripts/rubrics/applicability.mts';
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
import { resolveRubrics } from '../scripts/rubrics/resolver.mts';

test('isTestOrSupportPath classifies universal test and support paths as true and production paths as false', () => {
  const cases: Array<[string, boolean]> = [
    ['test/helper.ts', true],
    ['tests/Fixture.kt', true],
    ['testing/fakes.ts', true],
    ['__tests__/widget.tsx', true],
    ['__mocks__/api.ts', true],
    ['testFixtures/BookingBuilder.kt', true],
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

test('routeTestRubrics routes playwright.config.* to config diagnostics in module mode and skips it in file mode', () => {
  const configClassification = { activeKinds: ['test_support' as const], isPlaywright: true, isPlaywrightConfig: true };
  const fileTestRubric = resolveRubrics({ mode: 'file', target: 'test_code', hasRequirements: false, hasConventions: false });
  const moduleTestRubric = resolveRubrics({ mode: 'code', target: 'test_code', hasRequirements: false, hasConventions: false });

  assert.deepEqual(Object.keys(routeTestRubrics(configClassification, fileTestRubric).questions), []);
  assert.deepEqual(
    Object.keys(routeTestRubrics(configClassification, moduleTestRubric).questions),
    ['playwright_suite_and_config_diagnostics'],
  );
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
