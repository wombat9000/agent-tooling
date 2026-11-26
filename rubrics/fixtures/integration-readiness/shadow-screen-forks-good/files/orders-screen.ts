import { buildOrderColumns } from './orders-columns';
import { filterOrders, type OrderRow } from './orders-filters';

export function buildOrdersViewModel(params: {
  readonly rows: readonly OrderRow[];
  readonly query: string;
  readonly showFulfillmentStatus: boolean;
  readonly fulfillmentFilter?: 'queued' | 'shipped';
}) {
  return {
    columns: buildOrderColumns({ showFulfillmentStatus: params.showFulfillmentStatus }),
    rows: filterOrders(
      params.rows,
      params.query,
      params.showFulfillmentStatus ? params.fulfillmentFilter : undefined,
    ),
  };
}
