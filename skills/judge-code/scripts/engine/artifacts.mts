import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { safeFileSlug } from './scoring.mts';
import type { CodeRequest } from './types.mts';

export interface ArtifactDirRef {
  absDir?: string;
  relDir?: string;
}

export function saveJson(path: string, value: unknown): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  return body;
}

export function createPrivateOutDir(outArg: string | undefined): string | undefined {
  if (outArg === undefined) return undefined;
  const out = resolve(outArg);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  return out;
}

export function ensurePrivateDir(dirPath: string | undefined): void {
  if (dirPath !== undefined) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

export function serializeRequest(
  request: CodeRequest,
  absDir: string | undefined,
  filename = 'request.json',
): string {
  return absDir !== undefined
    ? saveJson(join(absDir, filename), request)
    : `${JSON.stringify(request, null, 2)}\n`;
}

export function saveResultIfDir(absDir: string | undefined, value: unknown): void {
  if (absDir !== undefined) {
    saveJson(join(absDir, 'result.json'), value);
  }
}

export function createSubdirAllocator(
  out: string | undefined,
  folderName: string,
  totalCount: number,
): (index: number, itemName: string) => ArtifactDirRef {
  let createdParent = false;
  return (index: number, itemName: string): ArtifactDirRef => {
    if (out === undefined) return {};
    if (!createdParent) {
      mkdirSync(join(out, folderName), { recursive: true, mode: 0o700 });
      createdParent = true;
    }
    const slug = safeFileSlug(index, totalCount, itemName);
    const relDir = `${folderName}/${slug}`;
    const absDir = join(out, relDir);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
    return { relDir, absDir };
  };
}
