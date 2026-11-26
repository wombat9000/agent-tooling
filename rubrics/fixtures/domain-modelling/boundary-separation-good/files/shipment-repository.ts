export interface SavedQuote {
  readonly id: string;
  readonly priceCents: number;
}

export interface SqlExecutor {
  execute(sql: string, params: readonly unknown[]): Promise<void>;
}

export class ShipmentQuoteRepository {
  private readonly db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  async save(quote: SavedQuote): Promise<void> {
    await this.db.execute(
      'INSERT INTO shipment_quotes (id, price_cents) VALUES ($1, $2)',
      [quote.id, quote.priceCents],
    );
  }
}
