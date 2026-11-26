import { OrdersScreen } from '../features/orders/orders-screen';
import { LegacyOrdersScreen } from '../features/orders/legacy/orders-screen';

export function OrdersRoute({ useLegacy }: { useLegacy: boolean }) {
  return useLegacy ? LegacyOrdersScreen() : OrdersScreen();
}
