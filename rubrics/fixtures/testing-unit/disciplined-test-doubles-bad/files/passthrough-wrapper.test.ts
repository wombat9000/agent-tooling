import test from 'node:test';
import { any, mock, verify, when } from './mock-framework';
import { GatewayForwarder, type PaymentGateway } from '../context/billing-service';
import type { Money } from '../context/money';

test('trivial one-line pass-through delegates to gateway mock', async () => {
  const mockGateway = mock<PaymentGateway>();
  const mockAmount = mock<Money>();
  when(() => mockGateway.charge(any(), any())).thenResolve({ receiptId: 'r-1' });

  const forwarder = new GatewayForwarder(mockGateway);
  await forwarder.charge('acct-1', mockAmount);

  verify(() => mockGateway.charge(any(), any())).once();
});
