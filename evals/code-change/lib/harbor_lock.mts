/**
 * Host-wide exclusive lock for container-running Harbor eval commands.
 *
 * Uses an atomically created lock file (`O_CREAT | O_EXCL`) containing JSON
 * owner metadata so concurrent worktrees or agents serialize Docker/Harbor runs,
 * reclaim stale locks from exited PIDs, and clean up reliably on exit or signal.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface HarborLockOwner {
  pid: number;
  token: string;
  command: string;
  task: string | null;
  cwd: string;
  startedAt: string;
}

export interface HarborLockOptions {
  command: string;
  task: string | null;
  cwd: string;
  noWait?: boolean;
  lockPath?: string;
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  initGraceMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
}

/** Raised when waiting for the Harbor lock is cancelled by SIGINT or SIGTERM. */
export class HarborLockInterruptedError extends Error {
  readonly signal: NodeJS.Signals;
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`Interrupted while waiting for Harbor lock (${signal}).`);
    this.name = 'HarborLockInterruptedError';
    this.signal = signal;
    this.exitCode = signalExitCode(signal);
  }
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_INIT_GRACE_MS = 2000;
const INIT_RETRY_DELAY_MS = 25;
const NO_WAIT_INIT_RETRIES = 8;

/** Convert a POSIX signal name to its conventional 128 + signum exit status. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = osConstants.signals[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

/**
 * Resolve the host-wide Harbor lock path.
 * Precedence: EVAL_LOCK_PATH, then ${XDG_CACHE_HOME}/agent-tooling-evals/harbor.lock,
 * then ~/.cache/agent-tooling-evals/harbor.lock.
 */
export function resolveHarborLockPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const explicit = env.EVAL_LOCK_PATH?.trim();
  if (explicit) return resolve(explicit);
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const cacheRoot = xdgCache ? resolve(xdgCache) : join(homeDirectory, '.cache');
  return join(cacheRoot, 'agent-tooling-evals', 'harbor.lock');
}

/**
 * Probe whether a process ID is currently alive.
 * Treats EPERM as alive (process exists under another user or permission boundary)
 * and ESRCH as dead. Non-positive or non-integer PIDs are always treated as dead.
 */
export function isProcessAlive(
  pid: number,
  killProcess: (pid: number, signal: number) => void = (targetPid, sig) => { process.kill(targetPid, sig); },
): boolean {
  const isValidPid = Number.isInteger(pid) && pid > 0;
  if (!isValidPid) return false;
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

/** Format lock owner metadata into a concise, human-readable summary for logs and errors. */
export function formatLockHolder(owner: HarborLockOwner): string {
  const taskPart = owner.task ? `, task: ${owner.task}` : '';
  return `PID ${owner.pid} (command: ${owner.command}${taskPart}, cwd: ${owner.cwd}, started: ${owner.startedAt})`;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function parseLockOwner(raw: string): HarborLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HarborLockOwner> | null;
    const hasValidShape = parsed !== null
      && typeof parsed === 'object'
      && typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.command === 'string'
      && typeof parsed.cwd === 'string'
      && typeof parsed.startedAt === 'string';
    if (!hasValidShape) return null;
    return {
      pid: parsed.pid!,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      command: parsed.command!,
      task: typeof parsed.task === 'string' ? parsed.task : null,
      cwd: parsed.cwd!,
      startedAt: parsed.startedAt!,
    };
  } catch {
    return null;
  }
}

type ExistingLockInspection =
  | { kind: 'missing' }
  | { kind: 'held'; owner: HarborLockOwner }
  | { kind: 'stale'; reason: string; raw: string }
  | { kind: 'initializing' };

function inspectExistingLock(
  lockPath: string,
  now: () => number,
  initGraceMs: number,
  isAlive: (pid: number) => boolean,
): ExistingLockInspection {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return { kind: 'missing' };
    throw error;
  }

  const owner = parseLockOwner(raw);
  if (owner) {
    if (isAlive(owner.pid)) return { kind: 'held', owner };
    return { kind: 'stale', reason: `exited ${formatLockHolder(owner)}`, raw };
  }

  const stats = statSync(lockPath, { throwIfNoEntry: false });
  if (!stats) return { kind: 'missing' };
  const lockAgeMs = now() - stats.mtimeMs;
  if (lockAgeMs < initGraceMs) return { kind: 'initializing' };
  return { kind: 'stale', reason: 'corrupt or incomplete metadata', raw };
}

function tryCreateLockFile(lockPath: string, owner: HarborLockOwner): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o644);
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) return false;
    throw error;
  }

  try {
    writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    try { unlinkSync(lockPath); } catch { /* Best-effort cleanup of partially created lock file. */ }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function removeStaleLock(lockPath: string, expectedRaw: string): boolean {
  let currentRaw: string;
  try {
    currentRaw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
  if (currentRaw !== expectedRaw) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return;
    throw error;
  }
  const owner = parseLockOwner(raw);
  const ownsLock = owner !== null && owner.token === token;
  if (!ownsLock) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolveDelay();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Acquire the host-wide Harbor lock, execute `action`, and guarantee lock release
 * on normal return, thrown errors, process exit, and SIGINT/SIGTERM signals.
 *
 * When another live process holds the lock:
 * - with `noWait: true`, throws immediately naming the holder;
 * - otherwise logs the holder once (and again if the holder changes) and polls until released.
 */
export async function withHarborLock<T>(
  options: HarborLockOptions,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const env = options.env ?? process.env;
  const lockPath = options.lockPath ?? resolveHarborLockPath(env);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initGraceMs = options.initGraceMs ?? DEFAULT_INIT_GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isAlive ?? ((pid: number) => isProcessAlive(pid));
  const log = options.log ?? ((message: string) => console.error(message));
  const noWait = options.noWait ?? false;

  const token = randomUUID();
  const lockCwd = resolve(options.cwd);
  const buildOwner = (): HarborLockOwner => ({
    pid: process.pid,
    token,
    command: options.command,
    task: options.task,
    cwd: lockCwd,
    startedAt: new Date(now()).toISOString(),
  });

  let acquired = false;
  let released = false;
  let interruptedSignal: NodeJS.Signals | null = null;
  const controller = new AbortController();

  const releaseOnce = () => {
    const shouldSkipRelease = !acquired || released;
    if (shouldSkipRelease) return;
    released = true;
    releaseOwnedLock(lockPath, token);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (interruptedSignal) {
      releaseOnce();
      process.exit(signalExitCode(signal));
    }
    interruptedSignal = signal;
    controller.abort(signal);
  };

  const onSigInt = () => onSignal('SIGINT');
  const onSigTerm = () => onSignal('SIGTERM');

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  process.on('exit', releaseOnce);

  try {
    let waited = false;
    let lastHolderKey: string | null = null;
    let initRetries = 0;

    while (!acquired) {
      if (interruptedSignal) throw new HarborLockInterruptedError(interruptedSignal);

      if (tryCreateLockFile(lockPath, buildOwner())) {
        acquired = true;
        if (waited) log(`Acquired Harbor lock (${lockPath}).`);
        break;
      }

      const inspection = inspectExistingLock(lockPath, now, initGraceMs, isAlive);
      if (inspection.kind === 'missing') continue;

      if (inspection.kind === 'stale') {
        if (removeStaleLock(lockPath, inspection.raw)) {
          log(`Reclaimed stale Harbor lock (${lockPath}) from ${inspection.reason}.`);
        }
        continue;
      }

      if (inspection.kind === 'initializing') {
        initRetries += 1;
        const exhaustedNoWaitRetries = noWait && initRetries >= NO_WAIT_INIT_RETRIES;
        if (exhaustedNoWaitRetries) {
          throw new Error(`Harbor lock (${lockPath}) is currently being initialized by another process. Retry or omit --no-wait.`);
        }
        await delay(INIT_RETRY_DELAY_MS, controller.signal);
        continue;
      }

      const holderSummary = formatLockHolder(inspection.owner);
      if (noWait) {
        throw new Error(
          `Harbor lock (${lockPath}) is held by ${holderSummary}. Re-run without --no-wait to wait for it to finish.`,
        );
      }

      const holderKey = `${inspection.owner.pid}:${inspection.owner.token}:${inspection.owner.startedAt}`;
      if (holderKey !== lastHolderKey) {
        log(`Waiting for Harbor lock (${lockPath}), currently held by ${holderSummary}...`);
        lastHolderKey = holderKey;
      }
      waited = true;
      await delay(pollIntervalMs, controller.signal);
    }

    return await action(controller.signal);
  } finally {
    releaseOnce();
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    process.off('exit', releaseOnce);
  }
}
