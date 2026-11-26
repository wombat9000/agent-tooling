import { refillBucket, type BucketState } from './token-bucket';

export function tryConsumeToken(
  state: BucketState,
  capacity: number,
  refillPerSecond: number,
  nowMs: number,
): { readonly allowed: boolean; readonly nextState: BucketState } {
  const refilled = refillBucket(state, capacity, refillPerSecond, nowMs);
  if (refilled.tokens < 1) {
    return { allowed: false, nextState: refilled };
  }
  return { allowed: true, nextState: { tokens: refilled.tokens - 1, lastRefillMs: refilled.lastRefillMs } };
}
