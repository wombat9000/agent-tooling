export interface OrderLine {
  sku: string;
  quantity: number;
}

export interface Order {
  id: string;
  status: 'draft' | 'confirmed';
  lines: OrderLine[];
}

const recentOrders: Order[] = [];

export function confirmOrder(order: Order, bonusSku?: string): Order {
  order.status = 'confirmed';
  if (bonusSku) {
    order.lines.push({ sku: bonusSku, quantity: 1 });
  }
  recentOrders.push(order);
  return order;
}

export function getRecentOrders(): Order[] {
  return recentOrders;
}
