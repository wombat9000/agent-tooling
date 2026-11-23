/**
 * Local concurrency policy and busy-Docker host guard for `pnpm eval run`.
 *
 * Keeps default local runs conservative (2 concurrent trials) and steps down to 1
 * when other containers are already running on the host, unless the caller passed
 * an explicit `--concurrency` value.
 */
import { spawnSync } from 'node:child_process';

export const DEFAULT_RUN_CONCURRENCY = 2;
export const BUSY_DOCKER_CONCURRENCY = 1;

const DOCKER_INSPECT_TIMEOUT_MS = 5000;

export interface ConcurrencyDecision {
  concurrency: number;
  warning: string | null;
}

/**
 * Count running Docker containers using `docker ps -q`.
 * Returns 0 gracefully if Docker is unavailable, exits non-zero, or times out.
 */
export function countRunningDockerContainers(
  env: NodeJS.ProcessEnv = process.env,
  dockerCommand: string = 'docker',
): number {
  const result = spawnSync(dockerCommand, ['ps', '-q'], {
    encoding: 'utf8',
    env,
    timeout: DOCKER_INSPECT_TIMEOUT_MS,
  });
  const failed = Boolean(result.error) || result.status !== 0;
  if (failed) return 0;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .length;
}

function formatContainerCount(count: number): string {
  return count === 1 ? '1 Docker container is' : `${count} Docker containers are`;
}

/**
 * Choose effective concurrency for `pnpm eval run` given an optional explicit
 * `--concurrency` value and the count of currently running Docker containers.
 *
 * - Without explicit `--concurrency`: defaults to 2, stepping down to 1 with a warning
 *   when other containers are already running.
 * - With explicit `--concurrency`: preserves the requested value and still emits a
 *   short warning when other containers are already running.
 */
export function resolveRunConcurrency(
  requestedConcurrency: number | undefined,
  activeContainers: number,
): ConcurrencyDecision {
  const hasExplicitConcurrency = requestedConcurrency !== undefined;
  const hasActiveContainers = activeContainers > 0;

  if (!hasActiveContainers) {
    return {
      concurrency: hasExplicitConcurrency ? requestedConcurrency : DEFAULT_RUN_CONCURRENCY,
      warning: null,
    };
  }

  const containerSummary = formatContainerCount(activeContainers);
  if (hasExplicitConcurrency) {
    return {
      concurrency: requestedConcurrency,
      warning: `Warning: ${containerSummary} already running; keeping explicit --concurrency ${requestedConcurrency}.`,
    };
  }

  return {
    concurrency: BUSY_DOCKER_CONCURRENCY,
    warning: `Warning: ${containerSummary} already running; stepping default --concurrency down from ${DEFAULT_RUN_CONCURRENCY} to ${BUSY_DOCKER_CONCURRENCY} to avoid VM contention.`,
  };
}
