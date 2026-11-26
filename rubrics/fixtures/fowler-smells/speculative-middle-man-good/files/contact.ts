export interface Contact {
  readonly id: string;
  readonly email: string;
  readonly company: string;
}

export function normalizeContactEmail(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned.includes('@')) {
    throw new Error('Contact email must contain @');
  }
  return cleaned;
}
