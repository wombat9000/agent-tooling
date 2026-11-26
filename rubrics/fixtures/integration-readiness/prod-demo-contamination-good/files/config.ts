export interface OrdersApiConfig {
  readonly baseUrl: string;
}

export function loadOrdersApiConfig(env: Readonly<Record<string, string | undefined>>): OrdersApiConfig {
  const baseUrl = env.ORDERS_API_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error('ORDERS_API_BASE_URL must be configured');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, '') };
}
