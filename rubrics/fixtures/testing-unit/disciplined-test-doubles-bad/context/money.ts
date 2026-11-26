export class Money {
  constructor(readonly cents: number, readonly currency: 'USD' | 'EUR') {
    if (!Number.isInteger(cents) || cents < 0) throw new RangeError('Invalid amount');
  }
  add(other: Money): Money {
    if (other.currency !== this.currency) throw new Error('Currency mismatch');
    return new Money(this.cents + other.cents, this.currency);
  }
}

export class TaxPolicy {
  constructor(private readonly basisPoints: number) {}
  taxFor(subtotal: Money): Money {
    return new Money(Math.round((subtotal.cents * this.basisPoints) / 10_000), subtotal.currency);
  }
}
