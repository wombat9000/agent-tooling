export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterToolbarProps {
  readonly query: string;
  readonly selectedStatus: string;
  readonly statusOptions: readonly FilterOption[];
  readonly onQueryChange: (nextQuery: string) => void;
  readonly onStatusChange: (nextStatus: string) => void;
  readonly onReset: () => void;
}

export function FilterToolbar({
  query,
  selectedStatus,
  statusOptions,
  onQueryChange,
  onStatusChange,
  onReset,
}: FilterToolbarProps) {
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search items"
      />
      <select
        value={selectedStatus}
        onChange={(event) => onStatusChange(event.target.value)}
      >
        {statusOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="button" onClick={onReset}>
        Reset
      </button>
    </form>
  );
}
