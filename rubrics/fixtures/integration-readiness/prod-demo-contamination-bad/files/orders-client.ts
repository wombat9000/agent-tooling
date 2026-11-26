import type { OrdersApiConfig } from './config';

export interface OrderSummary {
  readonly id: string;
  readonly customerName: string;
  readonly totalCents: number;
  readonly isDemo?: boolean;
}

// Temporary fallback seed data so staging previews still load when upstream is unavailable.
const FALLBACK_SAMPLE_ORDERS: readonly OrderSummary[] = [
  { id: 'demo_order_01', customerName: 'Acme Sample Co', totalCents: 14_900, isDemo: true },
  { id: 'demo_order_02', customerName: 'Northwind Preview', totalCents: 8_250, isDemo: true },
];

export async function fetchOrders(config: OrdersApiConfig, authHeader: string): Promise<readonly OrderSummary[]> {
  if (!config.baseUrl) {
    return [...FALLBACK_SAMPLE_ORDERS];
  }
  try {
    const response = await fetch(`${config.baseUrl}/api/orders`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      return [...FALLBACK_SAMPLE_ORDERS];
    }
    const live = (await response.json()) as OrderSummary[];
    return [...live, ...FALLBACK_SAMPLE_ORDERS];
  } catch {
    return [...FALLBACK_SAMPLE_ORDERS];
  }
}
