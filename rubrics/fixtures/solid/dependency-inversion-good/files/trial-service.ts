import type { Clock, TrialNotifier, TrialRepository } from './ports';
import { shouldExpireTrial } from './trial-policy';

export class TrialExpirationService {
  private readonly repository: TrialRepository;
  private readonly notifier: TrialNotifier;
  private readonly clock: Clock;

  constructor(repository: TrialRepository, notifier: TrialNotifier, clock: Clock) {
    this.repository = repository;
    this.notifier = notifier;
    this.clock = clock;
  }

  async expireDueTrials(): Promise<number> {
    const nowMs = this.clock.nowMs();
    const accounts = await this.repository.listActiveTrials();
    let expiredCount = 0;
    for (const account of accounts) {
      if (!shouldExpireTrial(account, nowMs)) continue;
      await this.repository.markExpired(account.id);
      await this.notifier.sendExpirationNotice(account.email, account.id);
      expiredCount += 1;
    }
    return expiredCount;
  }
}
