export type InvoiceStatus = 'draft' | 'issued' | 'paid';

export interface InvoiceLine {
  readonly description: string;
  readonly amountCents: number;
}

export interface Invoice {
  readonly id: string;
  readonly customerId: string;
  readonly lines: readonly InvoiceLine[];
  readonly status: InvoiceStatus;
  readonly issuedAtIso: string | null;
}

export function invoiceTotalCents(invoice: Invoice): number {
  return invoice.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

export function issueInvoice(invoice: Invoice, issuedAtIso: string): Invoice {
  if (invoice.status !== 'draft') {
    throw new Error('Only draft invoices can be issued');
  }
  if (invoice.lines.length === 0) {
    throw new Error('Cannot issue an empty invoice');
  }
  return { ...invoice, status: 'issued', issuedAtIso };
}
