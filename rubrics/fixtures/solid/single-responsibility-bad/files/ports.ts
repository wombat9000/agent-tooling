export interface MailTransport {
  send(to: string, subject: string, html: string): Promise<void>;
}

export interface ArchiveStore {
  putCsv(key: string, csv: string): Promise<void>;
  deleteOlderThanDays(days: number): Promise<number>;
}
