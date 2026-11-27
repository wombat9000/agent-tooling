export interface SelectionState {
  readonly selectedIds: readonly string[];
}

/** Creates an initial deduplicated selection state from optional preselected IDs. */
export function useInitialSelection(initialIds: readonly string[] = []): SelectionState {
  return { selectedIds: [...new Set(initialIds)] };
}

/** Returns a new selection state with the target ID toggled on or off. */
export function toggleSelectedId(state: SelectionState, targetId: string): SelectionState {
  const exists = state.selectedIds.includes(targetId);
  return {
    selectedIds: exists
      ? state.selectedIds.filter((id) => id !== targetId)
      : [...state.selectedIds, targetId],
  };
}

/** Retains only selected IDs that remain present in the current visible list. */
export function pruneSelection(state: SelectionState, visibleIds: readonly string[]): SelectionState {
  const visible = new Set(visibleIds);
  return {
    selectedIds: state.selectedIds.filter((id) => visible.has(id)),
  };
}
