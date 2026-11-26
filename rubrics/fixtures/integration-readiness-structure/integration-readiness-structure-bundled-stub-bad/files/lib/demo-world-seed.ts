export interface DemoOrder { readonly id: string; readonly totalCents: number; readonly status: string; }
export const DEMO_ORDERS: DemoOrder[] = [
  { id: 'ord-demo-1', totalCents: 4900, status: 'paid' },
  { id: 'ord-demo-2', totalCents: 12900, status: 'pending' },
];
