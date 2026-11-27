import type { SortOrder } from './search-panel';

export interface SearchQueryOptions {
  readonly query?: string;
  readonly statusFilter?: string;
  readonly sortOrder?: SortOrder;
  readonly page?: number;
  readonly pageSize?: number;
  readonly includeArchived?: boolean;
  readonly locale?: string;
}

export function buildSearchParams({
  query = '',
  statusFilter = 'all',
  sortOrder = 'newest',
  page = 1,
  pageSize = 25,
  includeArchived = false,
  locale = 'en-US',
}: SearchQueryOptions): URLSearchParams {
  const params = new URLSearchParams({
    status: statusFilter,
    sort: sortOrder,
    page: String(Math.max(1, page)),
    pageSize: String(Math.min(100, Math.max(1, pageSize))),
    includeArchived: String(includeArchived),
    locale,
  });
  if (query.trim()) {
    params.set('q', query.trim());
  }
  return params;
}
