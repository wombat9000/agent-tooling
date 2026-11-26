export interface BillingSummaryProps {
  readonly customerName: string;
  readonly planName: string;
  readonly billingCycle: 'monthly' | 'annual';
  readonly seatCount: number;
  readonly ratePerSeatCents: number;
  readonly currencyCode: string;
  readonly nextRenewalDate: string;
  readonly taxExempt: boolean;
  readonly onRequestUpgrade: () => void;
}
