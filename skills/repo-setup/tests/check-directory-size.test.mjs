import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/check-directory-size.mjs', import.meta.url));
const configName = 'directory-size.config.json';
const fixturePrefix = 'directory-size-test-';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, fixturePrefix));
  // Keep ownership independent of any path supplied to the CLI.
  const ownedRoot = realpathSync(root);
  t.after(() => {
    assert.equal(resolve(root), ownedRoot);
    assert.equal(dirname(ownedRoot), parent);
    assert.ok(basename(ownedRoot).startsWith(fixturePrefix));
    assert.ok(lstatSync(ownedRoot).isDirectory());
    assert.equal(realpathSync(ownedRoot), ownedRoot);
    rmSync(ownedRoot, { recursive: true, force: true });
  });
  return root;
}

function put(root, path, content = '') {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function files(root, path, count) {
  mkdirSync(join(root, path), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    put(root, join(path, `file-${index}.txt`));
  }
}

function config(root, value = {}, path = configName) {
  put(root, path, JSON.stringify(value));
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function expectReport(result, status, findings, warnings, errors) {
  assert.equal(result.status, status, result.output);
  const lines = result.output.split(/\r?\n/).filter((line) => /^(WARN|ERROR) /.test(line));
  assert.deepEqual(lines, findings, result.output);
  const summary = result.output.trim().split(/\r?\n/).at(-1);
  for (const [label, count] of [['warnings?', warnings], ['errors?', errors]]) {
    assert.match(summary, new RegExp(`(?:\\b${count} ${label}\\b|\\b${label}:? ${count}\\b)`, 'i'));
  }
}

function expectInvalid(result) {
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /\S/, 'invalid input must produce a diagnostic');
}

for (const [count, level, status] of [
  [20, null, 0], [21, 'WARN', 0], [30, 'WARN', 0], [31, 'ERROR', 1],
]) {
  test(`default thresholds: ${count} direct files`, (t) => {
    const root = fixture(t);
    config(root);
    files(root, '.', count - 1); // The required config is also a regular file.
    const findings = level ? [`${level} .: ${count} files (limit ${level === 'WARN' ? 20 : 30})`] : [];
    expectReport(run(root), status, findings, level === 'WARN' ? 1 : 0, level === 'ERROR' ? 1 : 0);
  });
}

test('counts dotfiles and tests directly, not directories or descendant files', (t) => {
  const root = fixture(t);
  config(root, { warn: 2, error: 4, roots: ['scope'] });
  for (const name of ['.hidden', 'example.test.mjs', 'plain.txt']) put(root, `scope/${name}`);
  files(root, 'scope/child', 5);
  files(root, 'scope/empty', 0);
  expectReport(run(root), 1, [
    'WARN scope: 3 files (limit 2)',
    'ERROR scope/child: 5 files (limit 4)',
  ], 1, 1);
});

test('overlapping roots report each directory once in ascending path order', (t) => {
  const root = fixture(t);
  config(root, { warn: 1, error: 2, roots: ['z', 'a/child', 'a'] });
  files(root, 'a', 2);
  files(root, 'a/child', 3);
  files(root, 'z', 2);
  files(root, 'outside-scope', 4);
  expectReport(run(root), 1, [
    'WARN a: 2 files (limit 1)',
    'ERROR a/child: 3 files (limit 2)',
    'WARN z: 2 files (limit 1)',
  ], 2, 1);
});

test('exclusions prune subtrees; exceptions exempt only exact direct counts', (t) => {
  const root = fixture(t);
  config(root, {
    warn: 1, error: 2, roots: ['scope'],
    exclude: [{ path: 'scope/excluded', reason: 'Generated subtree' }],
    exceptions: [
      { path: 'scope', reason: 'Existing flat directory' },
      { path: 'scope/exempt', reason: 'Existing flat directory' },
    ],
  });
  for (const path of ['scope', 'scope/child', 'scope/exempt', 'scope/exempt/child',
    'scope/excluded', 'scope/excluded/child']) files(root, path, 3);
  files(root, 'scope/excluded-other', 2);
  expectReport(run(root), 1, [
    'ERROR scope/child: 3 files (limit 2)',
    'WARN scope/excluded-other: 2 files (limit 1)',
    'ERROR scope/exempt/child: 3 files (limit 2)',
  ], 1, 2);
});

test('a root exception still checks child directories', (t) => {
  const root = fixture(t);
  config(root, { warn: 1, error: 2, exceptions: [{ path: '.', reason: 'Root entry points' }] });
  files(root, '.', 3);
  files(root, 'child', 2);
  expectReport(run(root), 0, ['WARN child: 2 files (limit 1)'], 1, 0);
});

test('built-in ignored directory basenames are pruned at every depth', (t) => {
  const root = fixture(t);
  config(root, { warn: 1, error: 2, roots: ['scope'] });
  const ignored = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
    '.output', '.cache', '.turbo'];
  for (const name of ignored) {
    files(root, `scope/${name}`, 3);
    files(root, `scope/${name}/child`, 3);
    files(root, `scope/ordinary/${name}/child`, 3);
  }
  files(root, 'scope/ordinary', 3);
  expectReport(run(root), 1, ['ERROR scope/ordinary: 3 files (limit 2)'], 0, 1);
});

const malformedConfigs = [
  ['invalid JSON', '{'],
  ['null document', 'null'],
  ['array document', '[]'],
  ['unknown field', { warning: 20 }],
  ['negative warning threshold', { warn: -1 }],
  ['fractional warning threshold', { warn: 1.5 }],
  ['unsafe warning threshold', { warn: Number.MAX_SAFE_INTEGER + 1 }],
  ['string warning threshold', { warn: '20' }],
  ['error threshold equal to warning', { warn: 5, error: 5 }],
  ['error threshold below warning', { warn: 5, error: 4 }],
  ['fractional error threshold', { error: 30.5 }],
  ['unsafe error threshold', { error: Number.MAX_SAFE_INTEGER + 1 }],
  ['empty roots', { roots: [] }],
  ['non-array roots', { roots: '.' }],
  ['non-string root', { roots: [1] }],
  ['parent traversal', { roots: ['../outside'] }],
  ['intermediate parent traversal', { roots: ['a/../b'] }],
  ['absolute root', (root) => ({ roots: [root] })],
  ['backslash path', { roots: ['a\\b'] }],
  ['empty path segment', { roots: ['a//b'] }],
  ['dot path segment', { roots: ['a/./b'] }],
  ['empty path', { roots: [''] }],
  ['trailing slash', { roots: ['a/'] }],
  ['non-array exclusions', { exclude: {} }],
  ['non-array exceptions', { exceptions: {} }],
  ['root exclusion', { exclude: [{ path: '.', reason: 'Everything' }] }],
  ['invalid exclusion path', { exclude: [{ path: '../outside', reason: 'External' }] }],
  ['invalid exception path', { exceptions: [{ path: '../outside', reason: 'External' }] }],
  ['blank exclusion reason', { exclude: [{ path: 'generated', reason: '  ' }] }],
  ['missing exception reason', { exceptions: [{ path: '.' }] }],
  ['duplicate exclusions', { exclude: [
    { path: 'generated', reason: 'First' }, { path: 'generated', reason: 'Second' },
  ] }],
  ['duplicate exceptions', { exceptions: [
    { path: '.', reason: 'First' }, { path: '.', reason: 'Second' },
  ] }],
];

for (const [name, value] of malformedConfigs) {
  test(`fails closed for ${name}`, (t) => {
    const owned = fixture(t);
    const root = join(owned, 'repo');
    // These paths exist so invalid syntax cannot pass via a missing-root error.
    for (const path of ['repo/a/b', 'repo/b', 'repo/a\\b', 'outside']) {
      mkdirSync(join(owned, path), { recursive: true });
    }
    const document = typeof value === 'function' ? value(root) : value;
    put(root, configName, typeof document === 'string' ? document : JSON.stringify(document));
    expectInvalid(run(root));
  });
}

for (const kind of ['missing', 'regular file']) {
  test(`fails closed for a ${kind} configured root`, (t) => {
    const root = fixture(t);
    config(root, { roots: ['target'] });
    if (kind === 'regular file') put(root, 'target');
    expectInvalid(run(root));
  });
}

test('ignores file, directory, and broken symlinks during traversal', (t) => {
  const root = fixture(t);
  config(root, { warn: 0, error: 1, roots: ['scope'] });
  files(root, 'scope', 1);
  files(root, 'target/child', 3);
  put(root, 'target/file');
  symlinkSync(join(root, 'target/file'), join(root, 'scope/file-link'), 'file');
  symlinkSync(join(root, 'target'), join(root, 'scope/directory-link'), 'dir');
  symlinkSync(join(root, 'missing'), join(root, 'scope/broken-link'), 'file');
  expectReport(run(root), 0, ['WARN scope: 1 files (limit 0)'], 1, 0);
});

for (const path of ['alias', 'alias/child']) {
  test(`rejects configured roots through symlinks: ${path}`, (t) => {
    const root = fixture(t);
    files(root, 'target/child', 0);
    symlinkSync(join(root, 'target'), join(root, 'alias'), 'dir');
    config(root, { roots: [path] });
    expectInvalid(run(root));
  });
}

for (const absolute of [false, true]) {
  test(`--config resolves an ${absolute ? 'absolute' : 'explicit relative'} override`, (t) => {
    const root = fixture(t);
    put(root, configName, '{'); // Reading the default instead must fail.
    config(root, { warn: 0, error: 1, roots: ['scope'] }, 'settings/policy.json');
    files(root, 'scope', 2);
    const path = absolute ? join(root, 'settings/policy.json') : 'settings/policy.json';
    expectReport(run(root, ['--config', path]), 1, ['ERROR scope: 2 files (limit 1)'], 0, 1);
  });
}

test('--help succeeds without a config and prints usage', (t) => {
  const root = fixture(t);
  const result = run(root, ['--help']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /usage/i);
});

for (const args of [[], ['--unknown'], [configName], ['--config'],
  ['--config', 'missing.json'], ['--config', '.']]) {
  test(`fails closed for config I/O or invalid options: ${JSON.stringify(args)}`, (t) => {
    const root = fixture(t);
    // Invalid flags must fail independently of the required-config guard.
    if (args.length > 0) config(root);
    expectInvalid(run(root, args));
  });
}
