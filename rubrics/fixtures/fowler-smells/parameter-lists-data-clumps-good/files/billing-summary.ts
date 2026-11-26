import { dispatchLegacyAuditEvent } from './legacy-audit-client';
import type { BillingSummaryProps } from './types';

export function formatBillingBanner({
  customerName,
  planName,
  billingCycle,
  seatCount,
  ratePerSeatCents,
  currencyCode,
  nextRenewalDate,
  taxExempt,
}: BillingSummaryProps): string {
  const total = ((seatCount * ratePerSeatCents) / 100).toFixed(2);
  const taxNote = taxExempt ? 'tax-exempt' : 'plus applicable tax';
  return `${customerName} — ${planName} (${billingCycle}): ${currencyCode} ${total} (${taxNote}), renews ${nextRenewalDate}`;
}

export function recordUpgradeClick(accountId: string, actorEmail: string): void {
  dispatchLegacyAuditEvent(
    accountId,
    actorEmail,
    'billing.upgrade_requested',
    'web',
    true,
    0,
    null,
    'v2',
  );
}
