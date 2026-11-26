const SHARED_STORAGE_KEY = 'reports_main_table_columns';

export function saveTableColumns(storage: Storage, visibleColumns: readonly string[]): void {
  storage.setItem(SHARED_STORAGE_KEY, JSON.stringify(visibleColumns));
}

export function loadTableColumns(storage: Storage): string[] | null {
  const raw = storage.getItem(SHARED_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as string[]) : null;
}
