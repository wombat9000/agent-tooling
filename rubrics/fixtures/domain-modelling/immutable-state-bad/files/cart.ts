export interface CartLine {
  sku: string;
  quantity: number;
}

export class ShoppingCart {
  static activeCarts: ShoppingCart[] = [];
  id: string;
  lines: CartLine[] = [];
  checkedOut = false;

  constructor(id: string) {
    this.id = id;
    ShoppingCart.activeCarts.push(this);
  }

  addItem(sku: string, quantity: number): void {
    const existing = this.lines.find((line) => line.sku === sku);
    if (existing) {
      existing.quantity += quantity;
    } else {
      this.lines.push({ sku, quantity });
    }
  }

  checkout(): void {
    this.checkedOut = true;
  }
}
