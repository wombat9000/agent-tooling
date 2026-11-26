import type { FulfillmentLane, OrderRecord, OrderStatus } from './order-types';

export interface ActionRequest {
  readonly method: string;
  readonly orderId: string;
  readonly traceId: string;
  readonly contentType: string;
}

export interface OrderBannerState {
  readonly isOpen: boolean;
  readonly isSubmitting: boolean;
  readonly itemCount: number;
  readonly heading: string;
}

export function canCancelOrder(status: OrderStatus, lane: FulfillmentLane): boolean {
  if (status === 'delivered' || status === 'cancelled') {
    return false;
  }
  return status === 'pending' || (status === 'packed' && lane !== 'same_day');
}

export function buildOrderBanner(order: OrderRecord, isOpen: boolean, isSubmitting: boolean): OrderBannerState {
  const heading = order.status === 'shipped' ? 'On the way' : 'Order active';
  return {
    isOpen,
    isSubmitting,
    itemCount: order.lines.length,
    heading,
  };
}

export function handleCancelHttpRequest(req: ActionRequest, order: OrderRecord): { status: number; body: string } {
  if (req.method !== 'POST') {
    return { status: 405, body: 'Method Not Allowed' };
  }
  if (req.contentType !== 'application/json') {
    return { status: 415, body: 'Unsupported Media Type' };
  }
  if (!canCancelOrder(order.status, order.lane)) {
    return { status: 409, body: `Order ${req.orderId} cannot be cancelled` };
  }
  return { status: 204, body: '' };
}
