export type SortOrder = 'newest' | 'oldest' | 'title';

export interface SearchPanelProps {
  readonly query: string;
  readonly statusFilter: string;
  readonly sortOrder: SortOrder;
  readonly resultCount: number;
  readonly isLoading: boolean;
  readonly onQueryChange: (value: string) => void;
  readonly onStatusFilterChange: (value: string) => void;
  readonly onResetFilters: () => void;
}

export function SearchPanel({
  query,
  statusFilter,
  sortOrder,
  resultCount,
  isLoading,
  onQueryChange,
  onStatusFilterChange,
  onResetFilters,
}: SearchPanelProps) {
  return (
    <section aria-busy={isLoading}>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Filter records"
      />
      <select
        value={statusFilter}
        onChange={(event) => onStatusFilterChange(event.target.value)}
      >
        <option value="all">All</option>
        <option value="active">Active</option>
        <option value="archived">Archived</option>
      </select>
      <span>{isLoading ? 'Loading...' : `${resultCount} results (${sortOrder})`}</span>
      <button type="button" onClick={onResetFilters}>
        Reset
      </button>
    </section>
  );
}
