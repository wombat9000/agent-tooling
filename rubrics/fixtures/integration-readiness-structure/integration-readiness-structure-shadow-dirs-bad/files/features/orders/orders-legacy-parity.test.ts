import { ORDER_COLUMNS } from './orders-columns';
import { LEGACY_ORDER_COLUMNS } from './legacy/orders-columns';

export const parityCheck = ORDER_COLUMNS.length === LEGACY_ORDER_COLUMNS.length;
