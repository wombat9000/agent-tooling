import type { DocumentPayload, DocumentWorker } from './document-worker';

export class ThermalLabelPrinter implements DocumentWorker {
  readonly printedIds: string[] = [];

  async print(doc: DocumentPayload): Promise<void> {
    this.printedIds.push(doc.id);
  }

  async scan(): Promise<DocumentPayload> { throw new Error('Scanning not supported'); }
  async fax(): Promise<void> { throw new Error('Fax not supported'); }
  async runOcr(): Promise<string> { throw new Error('OCR not supported'); }
  async signPdf(): Promise<Uint8Array> { throw new Error('Signing not supported'); }
  async archive(): Promise<string> { throw new Error('Archiving not supported'); }
}
