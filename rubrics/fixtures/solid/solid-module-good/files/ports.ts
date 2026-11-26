import type { Invoice } from './invoice';

export interface InvoiceRepository {
  findById(id: string): Promise<Invoice | null>;
  save(invoice: Invoice): Promise<void>;
}

export interface Clock {
  nowIso(): string;
}
