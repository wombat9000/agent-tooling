export interface DocumentPayload {
  readonly id: string;
  readonly content: string;
}

export interface DocumentWorker {
  print(doc: DocumentPayload): Promise<void>;
  scan(trayIndex: number): Promise<DocumentPayload>;
  fax(doc: DocumentPayload, dialNumber: string): Promise<void>;
  runOcr(doc: DocumentPayload): Promise<string>;
  signPdf(doc: DocumentPayload, certPem: string): Promise<Uint8Array>;
  archive(documentId: string): Promise<string>;
}
