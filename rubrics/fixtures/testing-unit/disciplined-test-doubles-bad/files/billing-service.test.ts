import test from 'node:test';
import { any, mock, verify, verifyInOrder, when } from './mock-framework';
import { BillingService, type PaymentGateway } from '../context/billing-service';
import type { Money, TaxPolicy } from '../context/money';

test('charges order by mocking Money and TaxPolicy with duplicated predicates and strict call order', async () => {
  const mockSubtotal = mock<Money>();
  const mockTax = mock<Money>();
  const mockTotal = mock<Money>();
  const mockTaxPolicy = mock<TaxPolicy>();
  const mockGateway = mock<PaymentGateway>();

  when(() => mockTaxPolicy.taxFor(mockSubtotal)).thenReturn(mockTax);
  when(() => mockSubtotal.add(mockTax)).thenReturn(mockTotal);
  when(() => mockGateway.charge('acct-7', mockTotal)).thenResolve({ receiptId: 'rcpt-1' });

  const service = new BillingService(mockTaxPolicy, mockGateway);
  await service.chargeOrder('acct-7', mockSubtotal);

  verifyInOrder([
    () => mockTaxPolicy.taxFor(mockSubtotal),
    () => mockSubtotal.add(mockTax),
    () => mockGateway.charge('acct-7', mockTotal),
  ]);
  verify(() => mockGateway.charge(any(), any())).once();
});
