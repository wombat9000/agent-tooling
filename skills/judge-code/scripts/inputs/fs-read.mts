import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface BoundedReadResult {
  buffer: Buffer;
  size: number;
}

export function canonicalizeOrFallback(targetPath: string, fallback: string = resolve(targetPath)): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return fallback;
  }
}

export function isPathInsideDir(candidate: string, rootDir: string): boolean {
  const rel = relative(rootDir, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function toPosixRelativeWithin(fromDir: string, absPath: string): string | null {
  const rel = relative(fromDir, absPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join('/');
}

/** Open and read a regular file without following symlinks, enforcing a byte cap. */
export function readRegularFileBuffer(params: {
  path: string;
  maxBytes: number;
  onExceedsMax?: (size: number) => void;
  onSizeRead?: (size: number) => void;
  nonRegularError?: string;
}): BoundedReadResult | null {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(params.path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      if (params.nonRegularError) throw new Error(params.nonRegularError);
      return null;
    }
    if (stat.size > params.maxBytes) {
      if (params.onExceedsMax) params.onExceedsMax(stat.size);
      else return null;
    }
    const buf = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buf.length) {
      const bytesRead = readSync(fd, buf, size, buf.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    params.onSizeRead?.(size);
    return { buffer: buf.subarray(0, size), size };
  } finally {
    closeSync(fd);
  }
}

/** Decode UTF-8 strictly (fatal on invalid sequences) and reject NUL-bearing binary text. */
export function decodeStrictUtf8Text(data: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}
