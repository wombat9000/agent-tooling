export interface OrdersApiConfig {
  readonly baseUrl: string | null;
}

export function loadOrdersApiConfig(env: Readonly<Record<string, string | undefined>>): OrdersApiConfig {
  const baseUrl = env.ORDERS_API_BASE_URL?.trim() || null;
  return { baseUrl };
}
