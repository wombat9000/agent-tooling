import { issueInvoice, type Invoice } from './invoice';
import type { Clock, InvoiceRepository } from './ports';

export class InvoiceService {
  private readonly repository: InvoiceRepository;
  private readonly clock: Clock;

  constructor(repository: InvoiceRepository, clock: Clock) {
    this.repository = repository;
    this.clock = clock;
  }

  async issue(invoiceId: string): Promise<Invoice> {
    const existing = await this.repository.findById(invoiceId);
    if (!existing) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }
    const issued = issueInvoice(existing, this.clock.nowIso());
    await this.repository.save(issued);
    return issued;
  }
}
