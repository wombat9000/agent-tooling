import type { SubscriptionRepository } from './ports';
import type { Subscription } from './subscription';

export class BillingService {
  private readonly repo: SubscriptionRepository;

  constructor(repo: SubscriptionRepository) {
    this.repo = repo;
  }

  async handleFailedCharge(subscriptionId: string): Promise<Subscription> {
    const current = await this.repo.findById(subscriptionId);
    if (!current) throw new Error(`Unknown subscription: ${subscriptionId}`);
    const updated = current.recordPaymentFailure();
    await this.repo.save(updated);
    return updated;
  }
}
