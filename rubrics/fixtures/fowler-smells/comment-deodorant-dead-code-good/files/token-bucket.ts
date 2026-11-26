export interface BucketState {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

export interface BucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export function refillBucket(state: BucketState, config: BucketConfig, nowMs: number): BucketState {
  // Clamp negative elapsed time when wall clocks step backward across NTP adjustments.
  const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
  const addedTokens = (elapsedMs / 1_000) * config.refillPerSecond;
  return {
    tokens: Math.min(config.capacity, state.tokens + addedTokens),
    lastRefillMs: Math.max(state.lastRefillMs, nowMs),
  };
}
