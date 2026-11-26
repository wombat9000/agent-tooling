export class SubscriptionRecord {
  id: string;
  seats: number;
  pricePerSeatCents: number;
  discountPercent: number;
  state: 'active' | 'past_due' | 'cancelled';
  failedPaymentAttempts: number;
  graceDaysRemaining: number;

  constructor(
    id: string,
    seats: number,
    pricePerSeatCents: number,
    discountPercent: number,
    state: 'active' | 'past_due' | 'cancelled',
    failedPaymentAttempts: number,
    graceDaysRemaining: number,
  ) {
    this.id = id;
    this.seats = seats;
    this.pricePerSeatCents = pricePerSeatCents;
    this.discountPercent = discountPercent;
    this.state = state;
    this.failedPaymentAttempts = failedPaymentAttempts;
    this.graceDaysRemaining = graceDaysRemaining;
  }
}
