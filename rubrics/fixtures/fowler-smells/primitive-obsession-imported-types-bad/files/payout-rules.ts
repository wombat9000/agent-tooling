export function requiresManualApproval(
  accountTier: string,
  kycStatus: string,
  payoutAmountCents: number,
  holdFlags: [boolean, boolean, boolean],
): boolean {
  const [isNewBank, isCrossBorder, isHighVelocity] = holdFlags;
  if (kycStatus === 'pending_kyc' || kycStatus === 'manual_hold') {
    return true;
  }
  if (accountTier === 'gold_vip' && payoutAmountCents <= 250_000 && !isHighVelocity) {
    return false;
  }
  if (accountTier === 'starter_free' && payoutAmountCents > 25_000) {
    return true;
  }
  return isNewBank || (isCrossBorder && payoutAmountCents > 50_000) || isHighVelocity;
}

export function settlementDelayHours(accountTier: string, kycStatus: string, payoutAmountCents: number): number {
  if (kycStatus === 'pending_kyc' || kycStatus === 'manual_hold') {
    return 72;
  }
  if (accountTier === 'gold_vip' && payoutAmountCents <= 250_000) {
    return 4;
  }
  if (accountTier === 'starter_free' && payoutAmountCents > 25_000) {
    return 48;
  }
  return 24;
}
