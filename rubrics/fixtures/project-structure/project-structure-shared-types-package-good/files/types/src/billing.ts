export interface BillingInvoice {
  readonly id: string;
  readonly organizationId: string;
  readonly amountCents: number;
  readonly currency: string;
}
