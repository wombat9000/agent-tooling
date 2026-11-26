export interface TaxRule { getRate(): number; getRegionCode(): string; }
export interface Country { getCode(): string; getTaxRule(): TaxRule; }
export interface Address { getCountry(): Country; getPostalCode(): string; }
export interface BillingProfile { getPrimaryAddress(): Address; getCurrencyCode(): string; }
export interface Account { getBillingProfile(): BillingProfile; }
export interface Customer { getAccount(): Account; }
export interface Order { getId(): string; getCustomer(): Customer; getSubtotalCents(): number; }
