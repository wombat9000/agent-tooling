#!/usr/bin/env node
/**
 * Synchronize shipped rubrics from authoritative top-level rubrics/ into skills/judge-code/rubrics/.
 * Supports --check mode for offline CI/test parity verification.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const AUTHORITATIVE_RUBRICS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SKILL_RUBRICS_DIR = fileURLToPath(new URL('../skills/judge-code/rubrics', import.meta.url));
export const SHIPPED_TARGETS = new Set(['production_code', 'project_structure', 'test_code']);
const KNOWN_TARGETS = new Set(['production_code', 'project_structure', 'test_code', 'review']);

const USAGE = `Usage: node rubrics/sync.mts [--check]

Synchronize shipped rubrics (target: production_code, project_structure, or test_code) from
top-level rubrics/ into skills/judge-code/rubrics/, removing any stale copies.

  --check     Verify exact file set and SHA-256 parity without modifying files
  --help, -h  Show this help
`;

export interface HashMismatch {
  file: string;
  sourceHash: string;
  targetHash: string;
}

export interface RubricSyncCheckResult {
  inSync: boolean;
  expectedFiles: string[];
  missing: string[];
  extra: string[];
  mismatched: HashMismatch[];
}

export interface RubricSyncResult {
  expectedFiles: string[];
  copied: string[];
  removed: string[];
  unchanged: string[];
}

export function sha256Buffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

function listJsonFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Return sorted *.json filenames in sourceDir whose target is shipped by judge-code. */
export function listShippedRubricFiles(sourceDir: string = AUTHORITATIVE_RUBRICS_DIR): string[] {
  const files = listJsonFiles(sourceDir);
  const shipped: string[] = [];
  for (const file of files) {
    const fullPath = join(sourceDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid JSON in ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Rubric file ${file} must contain a JSON object`);
    }
    const rawTarget = (parsed as Record<string, unknown>).target;
    const target = rawTarget === undefined ? 'production_code' : rawTarget;
    if (typeof target !== 'string' || !KNOWN_TARGETS.has(target)) {
      throw new Error(`Rubric file ${file} has unsupported target: ${String(rawTarget)}`);
    }
    if (SHIPPED_TARGETS.has(target)) {
      shipped.push(file);
    }
  }
  return shipped;
}

/** Compare exact shipped file set and SHA-256 digests between sourceDir and targetDir. */
export function checkRubricSync(
  sourceDir: string = AUTHORITATIVE_RUBRICS_DIR,
  targetDir: string = SKILL_RUBRICS_DIR,
): RubricSyncCheckResult {
  const expectedFiles = listShippedRubricFiles(sourceDir);
  const expectedSet = new Set(expectedFiles);
  const actualFiles = listJsonFiles(targetDir);
  const actualSet = new Set(actualFiles);

  const missing: string[] = [];
  const mismatched: HashMismatch[] = [];
  for (const file of expectedFiles) {
    if (!actualSet.has(file)) {
      missing.push(file);
      continue;
    }
    const sourceHash = sha256File(join(sourceDir, file));
    const targetHash = sha256File(join(targetDir, file));
    if (sourceHash !== targetHash) {
      mismatched.push({ file, sourceHash, targetHash });
    }
  }

  const extra = actualFiles.filter((file) => !expectedSet.has(file));

  return {
    inSync: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    expectedFiles,
    missing,
    extra,
    mismatched,
  };
}

export function formatSyncDrift(result: RubricSyncCheckResult): string {
  const lines: string[] = ['skills/judge-code/rubrics/ is out of sync with authoritative rubrics/:'];
  for (const file of result.missing) {
    lines.push(`  - missing: ${file}`);
  }
  for (const file of result.extra) {
    lines.push(`  - stale extra file: ${file}`);
  }
  for (const { file, sourceHash, targetHash } of result.mismatched) {
    lines.push(`  - sha256 mismatch: ${file} (rubrics/=${sourceHash.slice(0, 12)}, skills/judge-code/rubrics/=${targetHash.slice(0, 12)})`);
  }
  lines.push('Run `pnpm sync:rubrics` to synchronize skills/judge-code/rubrics/ from rubrics/.');
  return lines.join('\n');
}

/** Mirror shipped rubrics from sourceDir into targetDir and delete stale extra *.json files. */
export function syncRubrics(
  sourceDir: string = AUTHORITATIVE_RUBRICS_DIR,
  targetDir: string = SKILL_RUBRICS_DIR,
): RubricSyncResult {
  mkdirSync(targetDir, { recursive: true });
  const expectedFiles = listShippedRubricFiles(sourceDir);
  const expectedSet = new Set(expectedFiles);
  const actualFiles = listJsonFiles(targetDir);

  const copied: string[] = [];
  const unchanged: string[] = [];
  for (const file of expectedFiles) {
    const srcContent = readFileSync(join(sourceDir, file));
    const dstPath = join(targetDir, file);
    const dstExists = Boolean(statSync(dstPath, { throwIfNoEntry: false })?.isFile());
    if (!dstExists || sha256Buffer(srcContent) !== sha256File(dstPath)) {
      writeFileSync(dstPath, srcContent);
      copied.push(file);
    } else {
      unchanged.push(file);
    }
  }

  const removed: string[] = [];
  for (const file of actualFiles) {
    if (!expectedSet.has(file)) {
      rmSync(join(targetDir, file));
      removed.push(file);
    }
  }

  return { expectedFiles, copied, removed, unchanged };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.check) {
    const result = checkRubricSync();
    if (!result.inSync) {
      console.error(formatSyncDrift(result));
      process.exitCode = 1;
      return;
    }
    console.log(`OK: ${result.expectedFiles.length} shipped rubric(s) match between rubrics/ and skills/judge-code/rubrics/.`);
    return;
  }

  const result = syncRubrics();
  console.log(
    `Synced ${result.expectedFiles.length} shipped rubric(s) to skills/judge-code/rubrics/ `
    + `(copied: ${result.copied.length}, removed: ${result.removed.length}, unchanged: ${result.unchanged.length}).`,
  );
  if (result.copied.length > 0) console.log(`  copied: ${result.copied.join(', ')}`);
  if (result.removed.length > 0) console.log(`  removed: ${result.removed.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
