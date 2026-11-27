export interface ExpenseClaimRequest {
  readonly claimId: string;
  readonly claimType: string;
  readonly reviewStage: string;
  readonly amountCents: number;
  readonly isPriority: boolean;
  readonly isRush: boolean;
  readonly skipCap: boolean;
}

export interface ExpenseClaimDecision {
  readonly claimId: string;
  readonly approvedCents: number;
  readonly queueCode: string;
  readonly requiresAudit: boolean;
}
