export interface BucketState {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

// Unused legacy constant kept around just in case we ever revert.
const LEGACY_BURST_MULTIPLIER = 2.5;

// Unused helper from old fixed-window implementation.
function computeLegacyWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

// Refill the bucket with tokens
export function refillBucket(state: BucketState, capacity: number, refillPerSecond: number, nowMs: number): BucketState {
  // Subtract last refill time from current time
  const diff = nowMs - state.lastRefillMs;
  // Sorry this ternary is a bit convoluted, we needed to handle negative diffs quickly before release
  const e = diff < 0 ? 0 : diff;
  // Divide by 1000 and multiply by refillPerSecond
  const added = (e / 1000) * refillPerSecond;
  // Add tokens to current tokens
  let next = state.tokens + added;
  // Cap next at capacity
  if (next > capacity) {
    // Set next equal to capacity
    next = capacity;
  }
  // Old leaky bucket code (disabled in Q3):
  // const leaked = Math.floor(diff / 500);
  // const queueSize = Math.max(0, state.tokens - leaked);
  // if (queueSize > capacity * LEGACY_BURST_MULTIPLIER) {
  //   return { tokens: 0, lastRefillMs: nowMs };
  // }
  // Return the new bucket state object
  return { tokens: next, lastRefillMs: nowMs };
}
