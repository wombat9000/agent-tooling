import type { CartLine, ShoppingCart } from './types';

export function createCart(id: string): ShoppingCart {
  return { id, lines: [], checkedOut: false };
}

export function addItem(cart: ShoppingCart, sku: string, quantity: number): ShoppingCart {
  if (cart.checkedOut) {
    throw new Error('Cannot modify a checked-out cart');
  }
  const existing = cart.lines.find((line) => line.sku === sku);
  const updatedLines: readonly CartLine[] = existing
    ? cart.lines.map((line) => (line.sku === sku ? { ...line, quantity: line.quantity + quantity } : line))
    : [...cart.lines, { sku, quantity }];
  return { ...cart, lines: updatedLines };
}

export function checkoutCart(cart: ShoppingCart): ShoppingCart {
  if (cart.lines.length === 0) {
    throw new Error('Cannot checkout an empty cart');
  }
  return { ...cart, checkedOut: true };
}
