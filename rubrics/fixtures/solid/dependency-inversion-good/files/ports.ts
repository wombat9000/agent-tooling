import type { TrialAccount } from './trial-policy';

export interface TrialRepository {
  listActiveTrials(): Promise<readonly TrialAccount[]>;
  markExpired(accountId: string): Promise<void>;
}

export interface TrialNotifier {
  sendExpirationNotice(email: string, accountId: string): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}
