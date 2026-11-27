import type { ExpenseClaimDecision, ExpenseClaimRequest } from './claim-contract';
import { classifyReviewQueue, computeApprovedAmount } from './claim-rules';

export function processExpenseClaims(
  claims: readonly ExpenseClaimRequest[],
): ExpenseClaimDecision[] {
  return claims.map((claim) => {
    const approvedCents = computeApprovedAmount(
      claim.claimType,
      claim.amountCents,
      claim.isPriority,
      claim.isRush,
      claim.skipCap,
    );
    const queueCode = classifyReviewQueue(
      claim.claimType,
      claim.reviewStage,
      claim.amountCents,
      claim.isPriority,
      claim.isRush,
      claim.skipCap,
    );
    const requiresAudit =
      claim.reviewStage === 'pending_audit'
      || claim.reviewStage === 'escalated_hold'
      || (claim.claimType === 'travel_intl' && claim.amountCents > 250_000)
      || (claim.skipCap && claim.amountCents > 100_000);

    return {
      claimId: claim.claimId,
      approvedCents,
      queueCode,
      requiresAudit,
    };
  });
}
