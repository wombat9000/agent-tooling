export interface CartLine {
  readonly sku: string;
  readonly quantity: number;
}

export interface ShoppingCart {
  readonly id: string;
  readonly lines: readonly CartLine[];
  readonly checkedOut: boolean;
}
