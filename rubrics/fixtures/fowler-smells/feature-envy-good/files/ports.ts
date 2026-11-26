import type { Subscription } from './subscription';

export interface SubscriptionRepository {
  findById(id: string): Promise<Subscription | null>;
  save(subscription: Subscription): Promise<void>;
}
