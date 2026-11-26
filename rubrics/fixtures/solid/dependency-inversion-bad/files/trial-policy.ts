export interface TrialAccount {
  readonly id: string;
  readonly email: string;
  readonly trialEndsAtMs: number;
  readonly expired: boolean;
}

export function shouldExpireTrial(account: TrialAccount, nowMs: number): boolean {
  return !account.expired && nowMs >= account.trialEndsAtMs;
}
