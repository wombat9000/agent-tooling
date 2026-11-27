export function computeApprovedAmount(
  claimType: string,
  amountCents: number,
  isPriority: boolean,
  isRush: boolean,
  skipCap: boolean,
): number {
  let capCents = 150_000;
  if (claimType === 'travel_intl') {
    capCents = 450_000;
  } else if (claimType === 'equipment_capex') {
    capCents = 300_000;
  } else if (claimType === 'client_meals') {
    capCents = 50_000;
  }

  let effective = amountCents;
  if (isPriority && isRush) {
    effective = Math.round(effective * 1.15);
  } else if (isRush) {
    effective = Math.round(effective * 1.05);
  }

  if (skipCap) {
    return effective;
  }
  return Math.min(effective, capCents);
}

export function classifyReviewQueue(
  claimType: string,
  reviewStage: string,
  amountCents: number,
  isPriority: boolean,
  isRush: boolean,
  skipCap: boolean,
): string {
  if (reviewStage === 'pending_audit' || reviewStage === 'escalated_hold') {
    return 'AUDIT_L2';
  }
  if (claimType === 'travel_intl' && amountCents > 250_000) {
    return isPriority || isRush ? 'EXPEDITE_INTL' : 'FINANCE_INTL';
  }
  if (claimType === 'equipment_capex' && (skipCap || amountCents > 200_000)) {
    return 'CAPEX_BOARD';
  }
  return isPriority && isRush ? 'FAST_TRACK' : 'STANDARD';
}
