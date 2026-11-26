export type SubscriptionState = 'active' | 'past_due' | 'cancelled';

export class Subscription {
  readonly id: string;
  readonly seats: number;
  readonly pricePerSeatCents: number;
  readonly state: SubscriptionState;
  readonly failedPaymentAttempts: number;

  constructor(params: {
    readonly id: string;
    readonly seats: number;
    readonly pricePerSeatCents: number;
    readonly state: SubscriptionState;
    readonly failedPaymentAttempts: number;
  }) {
    this.id = params.id;
    this.seats = params.seats;
    this.pricePerSeatCents = params.pricePerSeatCents;
    this.state = params.state;
    this.failedPaymentAttempts = params.failedPaymentAttempts;
  }

  monthlyChargeCents(): number {
    return this.seats * this.pricePerSeatCents;
  }

  isInGracePeriod(): boolean {
    return this.state === 'past_due' && this.failedPaymentAttempts < 3;
  }

  recordPaymentFailure(): Subscription {
    const nextAttempts = this.failedPaymentAttempts + 1;
    const nextState: SubscriptionState = nextAttempts >= 3 ? 'cancelled' : 'past_due';
    return new Subscription({ ...this, failedPaymentAttempts: nextAttempts, state: nextState });
  }

  addSeats(extraSeats: number): Subscription {
    if (this.state !== 'active') throw new Error('Only active subscriptions can add seats');
    return new Subscription({ ...this, seats: this.seats + extraSeats });
  }
}
