export interface SearchSnapshot<T> {
  readonly query: string;
  readonly items: readonly T[];
}

export interface MutableRef<T> {
  current: T;
}

export function createSearchLifecycleController<T>() {
  const requestSeqRef: MutableRef<number> = { current: 0 };
  const abortRef: MutableRef<AbortController | null> = { current: null };
  const mountedRef: MutableRef<boolean> = { current: true };

  return {
    async runLatest(
      query: string,
      loader: (query: string, signal: AbortSignal) => Promise<readonly T[]>,
    ): Promise<SearchSnapshot<T> | null> {
      if (!mountedRef.current) return null;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      requestSeqRef.current += 1;
      const sequence = requestSeqRef.current;

      const items = await loader(query, controller.signal);
      if (!mountedRef.current || sequence !== requestSeqRef.current || controller.signal.aborted) {
        return null;
      }
      return { query, items: [...items] };
    },
    dispose(): void {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    },
  };
}
