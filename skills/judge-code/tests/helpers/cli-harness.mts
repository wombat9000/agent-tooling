import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  CodeRequest,
  FileJudgment,
  JudgeResult,
  ModuleJudgment,
} from '../../scripts/engine/types.mts';

const SKILL_DIR = fileURLToPath(new URL('../..', import.meta.url));

export type OpenRouterStubScenario =
  | 'offline'
  | 'pass'
  | 'scored'
  | 'warnings-only'
  | 'conventions-fail'
  | 'http-400'
  | 'partial-400'
  | 'key-echo';

const OPENROUTER_HTTP_STUB = `
import assert from 'node:assert/strict';

const scenario = process.env.JUDGE_OPENROUTER_STUB;
const firstArg = process.argv[2];
const isModuleCmd = firstArg === 'module';
const isStructureCmd = firstArg === 'structure';
const isFileCmd = !isModuleCmd && !isStructureCmd && firstArg !== 'list' && firstArg !== 'explain';
let networkCalls = 0;

globalThis.fetch = async (endpoint, init) => {
  networkCalls += 1;
  assert.equal(endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-api-key');

  if (scenario === 'http-400') {
    return new Response(
      JSON.stringify({ error: { message: 'Unknown model: typesafe/jev-1.14.0' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (scenario === 'key-echo') return new Response('echo fixture-api-key', { status: 500 });

  const json = JSON.parse(init.body);
  if (json.questions?.test_kind && Object.keys(json.questions).length === 1) {
    const filePath = String(json.state?.file_path ?? '');
    const content = String(json.state?.file_content ?? '');
    let choice = 'unit';
    const probs = { unit: 0, integration: 0, e2e_browser: 0, test_support: 0, other: 0 };
    if (filePath.includes('mixed-split')) {
      choice = 'unit';
      probs.unit = 0.72;
      probs.integration = 0.25;
      probs.e2e_browser = 0.01;
      probs.test_support = 0.01;
      probs.other = 0.01;
    } else if (filePath.includes('other-script')) {
      choice = 'other';
      probs.other = 1;
    } else if (filePath.includes('helper') || filePath.includes('driver') || filePath.includes('Fixture')) {
      choice = 'test_support';
      probs.test_support = 1;
    } else if (filePath.includes('e2e') || filePath.endsWith('.spec.ts') || filePath.endsWith('.spec.tsx') || content.includes('page.goto')) {
      choice = 'e2e_browser';
      probs.e2e_browser = 1;
    } else if (filePath.includes('integration') || content.includes('createServer')) {
      choice = 'integration';
      probs.integration = 1;
    } else {
      choice = 'unit';
      probs.unit = 1;
    }
    return Response.json({
      model: json.model + '-mock',
      answers: { test_kind: { type: 'choice', choice, probabilities: probs, confidence: 0.95 } },
    });
  }

  const fileNames = Object.keys(json.state.production_files ?? json.state.test_files ?? {});
  const singleFile = isFileCmd && fileNames.length === 1 ? fileNames[0] : null;
  if (scenario === 'partial-400' && singleFile?.endsWith('Room.kt')) {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid request for file' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const answers = Object.fromEntries(Object.keys(json.questions).map((id) => {
    let passProb = 0.92;
    let choice = 'pass';
    if (scenario === 'pass') {
      passProb = 0.92;
      choice = 'pass';
    } else if (scenario === 'conventions-fail') {
      if (id === 'follows_repo_conventions') { passProb = 0.25; choice = 'fail'; }
    } else if (scenario === 'warnings-only') {
      if (singleFile?.endsWith('Room.kt') && id === 'no_long_functions') { passProb = 0.65; choice = 'pass'; }
      else if (singleFile?.endsWith('Booking.kt') && id === 'direct_readability') { passProb = 0.74; choice = 'pass'; }
      else if (!isFileCmd && id === 'no_unnecessary_abstraction') { passProb = 0.65; choice = 'pass'; }
    } else if (singleFile?.endsWith('Booking.kt')) {
      if (id === 'no_long_functions') { passProb = 0.15; choice = 'fail'; }
      else if (id === 'no_primitive_obsession') { passProb = 0.50; choice = 'pass'; }
      else if (id === 'direct_readability') { passProb = 0.74; choice = 'pass'; }
    } else if (singleFile?.endsWith('Room.kt')) {
      if (id === 'no_long_functions') { passProb = 0.65; choice = 'pass'; }
    } else if (!isFileCmd) {
      const fail = ['direct_readability', 'modular_organization', 'single_responsibility', 'no_junk_drawer_directories'].includes(id);
      const borderline = id === 'no_unnecessary_abstraction';
      passProb = fail ? 0.2 : borderline ? 0.65 : 0.9;
      choice = fail ? 'fail' : 'pass';
    }
    return [id, {
      type: 'choice',
      choice,
      probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
      confidence: Number(Math.abs(2 * passProb - 1).toFixed(4)),
    }];
  }));
  return Response.json({ model: 'decisions-mock', answers });
};

process.on('exit', () => {
  if (scenario === 'offline') assert.equal(networkCalls, 0);
});
`;

export interface CliRunOptions {
  openRouterStub?: OpenRouterStubScenario;
  extraEnv?: Record<string, string>;
  cwd?: string;
}

export interface CliTestWorkspace {
  root: string;
  project: string;
  source: string;
  installed: string;
  runCli: (args: string[], options?: CliRunOptions) => SpawnSyncReturns<string>;
  runCliJson: (
    args: string[],
    options?: CliRunOptions,
  ) => { status: number | null; stderr: string; stdout: string; result: JudgeResult };
}

export function createCliTestWorkspace(t: TestContext, projectSubdir = 'project'): CliTestWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'installed-judge-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'installed');
  const project = join(root, projectSubdir);
  const source = join(project, 'booking');
  cpSync(SKILL_DIR, installed, { recursive: true });
  mkdirSync(source, { recursive: true });

  const fixtures: Record<string, string> = {
    'Booking.kt': 'package booking\nclass Booking(val room: Room)\n',
    'Room.kt': 'package booking\nclass Room\n',
    'env.ts': 'export const PORT = 8080;\n',
    'password.ts': 'export type PasswordHash = string;\n',
    'tests/Fixture.kt': 'excluded',
    '.hidden/Hidden.kt': 'excluded',
    'dist/output.ts': 'excluded',
    'BookingTest.kt': 'excluded',
    'types.d.ts': 'excluded',
    'fixture.spec.tsx': 'excluded',
  };
  for (const [file, text] of Object.entries(fixtures)) {
    const filePath = join(source, file);
    if (file.includes('/')) mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, text);
  }
  writeFileSync(join(project, 'Outside.kt'), 'excluded');
  symlinkSync(join(project, 'Outside.kt'), join(source, 'Link.kt'));
  writeFileSync(join(project, 'requirements.md'), 'Book a room.\n');
  writeFileSync(join(project, 'conventions.md'), 'Use mutable JPA entities when annotated with @Entity.\n');

  const httpStubPath = join(root, 'openrouter-http-stub.mjs');
  writeFileSync(httpStubPath, OPENROUTER_HTTP_STUB);

  function runCli(args: string[], options: CliRunOptions = {}) {
    const scenario = options.openRouterStub ?? 'offline';
    const env: NodeJS.ProcessEnv = { ...process.env, JUDGE_OPENROUTER_STUB: scenario };
    delete env.OPENROUTER_API_KEY;
    if (scenario !== 'offline') env.OPENROUTER_API_KEY = 'fixture-api-key';
    if (options.extraEnv) Object.assign(env, options.extraEnv);
    return spawnSync(
      process.execPath,
      ['--import', httpStubPath, join(installed, 'scripts/judge-code.mts'), ...args],
      { cwd: options.cwd ?? project, env, encoding: 'utf8' },
    );
  }

  function runCliJson(args: string[], options: CliRunOptions = {}) {
    const proc = runCli(args.includes('--json') ? args : [...args, '--json'], options);
    const result = JSON.parse(proc.stdout) as JudgeResult;
    return { status: proc.status, stderr: proc.stderr, stdout: proc.stdout, result };
  }

  return { source, root, project, installed, runCli, runCliJson };
}

export function runGitCommand(cwd: string, args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, `git ${args.join(' ')} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

export function writeExecutableScript(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

export function readSavedJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

export function readSavedRequest(filePath: string): CodeRequest {
  return readSavedJson<CodeRequest>(filePath);
}

export function findFileEntry(result: JudgeResult, filePath: string): FileJudgment {
  const found = result.file_results?.find((entry) => entry.file === filePath);
  assert.ok(found, `Expected file_results entry for ${filePath}`);
  return found;
}

export function findModuleEntry(result: JudgeResult, moduleName: string): ModuleJudgment {
  const found = result.module_results?.find((entry) => entry.module === moduleName);
  assert.ok(found, `Expected module_results entry for ${moduleName}`);
  return found;
}

export function withTempOpenRouterKey(t: TestContext, keyValue = 'unit-test-key'): void {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = keyValue;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
}
