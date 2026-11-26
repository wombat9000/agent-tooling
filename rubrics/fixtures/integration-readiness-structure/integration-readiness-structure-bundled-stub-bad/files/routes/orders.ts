import { getOrders, submitOrder } from '../features/orders/service';
export function loader() { return getOrders(); }
export function action(id: string, totalCents: number) { return submitOrder(id, totalCents); }
