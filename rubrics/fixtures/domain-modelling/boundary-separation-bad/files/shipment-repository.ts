export interface SavedQuote {
  readonly id: string;
  readonly priceCents: number;
}

export interface QuoteRepository {
  save(quote: SavedQuote): Promise<void>;
}
