import type { DocumentPrinter, PrintableDocument } from './document-ports';

export class ThermalLabelPrinter implements DocumentPrinter {
  readonly printedIds: string[] = [];

  async print(doc: PrintableDocument): Promise<void> {
    this.printedIds.push(doc.id);
  }
}
