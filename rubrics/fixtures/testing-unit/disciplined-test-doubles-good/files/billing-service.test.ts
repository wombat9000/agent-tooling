import assert from 'node:assert/strict';
import test from 'node:test';
import { BillingService, type PaymentGateway } from '../context/billing-service';
import { Money, TaxPolicy } from '../context/money';

class FakePaymentGateway implements PaymentGateway {
  readonly charges: Array<{ accountId: string; amount: Money }> = [];
  async charge(accountId: string, amount: Money): Promise<{ receiptId: string }> {
    this.charges.push({ accountId, amount });
    return { receiptId: `rcpt-${this.charges.length}` };
  }
}

test('charges subtotal plus real tax policy amount via external payment boundary', async () => {
  const gateway = new FakePaymentGateway();
  const service = new BillingService(new TaxPolicy(800), gateway);

  const result = await service.chargeOrder('acct-7', new Money(5_000, 'USD'));

  assert.equal(result.receiptId, 'rcpt-1');
  assert.deepEqual(result.total, new Money(5_400, 'USD'));
  assert.deepEqual(gateway.charges, [{ accountId: 'acct-7', amount: new Money(5_400, 'USD') }]);
});
