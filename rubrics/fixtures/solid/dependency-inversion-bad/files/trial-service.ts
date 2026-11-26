import { readFileSync, writeFileSync } from 'node:fs';
import { shouldExpireTrial, type TrialAccount } from './trial-policy';
import type { ExpirationBatchResult } from './types';

export class TrialExpirationService {
  async expireDueTrials(): Promise<ExpirationBatchResult> {
    const storePath = process.env.TRIAL_STORE_PATH ?? '/var/data/trials.json';
    const mailerUrl = process.env.MAILER_ENDPOINT ?? 'https://mail.internal/notices';
    const nowMs = Date.now();
    const accounts = JSON.parse(readFileSync(storePath, 'utf8')) as TrialAccount[];
    let expiredCount = 0;
    const updated = accounts.map((account) => {
      if (!shouldExpireTrial(account, nowMs)) return account;
      expiredCount += 1;
      return { ...account, expired: true };
    });
    writeFileSync(storePath, JSON.stringify(updated, null, 2));
    for (const account of accounts) {
      if (!shouldExpireTrial(account, nowMs)) continue;
      await fetch(mailerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: account.email, accountId: account.id }),
      });
    }
    return { expiredCount };
  }
}
