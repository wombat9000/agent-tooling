export interface PrintableDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export interface DocumentPrinter {
  print(doc: PrintableDocument): Promise<void>;
}

export interface DocumentArchiver {
  archive(documentId: string): Promise<string>;
}
