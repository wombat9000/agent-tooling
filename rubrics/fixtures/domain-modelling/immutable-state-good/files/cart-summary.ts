import type { ShoppingCart } from './types';

export function totalItemCount(cart: ShoppingCart): number {
  return cart.lines.reduce((total, line) => total + line.quantity, 0);
}
