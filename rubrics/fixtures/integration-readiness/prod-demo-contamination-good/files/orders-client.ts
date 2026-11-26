import type { OrdersApiConfig } from './config';

export interface OrderSummary {
  readonly id: string;
  readonly customerName: string;
  readonly totalCents: number;
}

export async function fetchOrders(config: OrdersApiConfig, authHeader: string): Promise<readonly OrderSummary[]> {
  const response = await fetch(`${config.baseUrl}/api/orders`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Orders API request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as OrderSummary[];
}
