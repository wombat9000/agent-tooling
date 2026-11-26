import { useEffect, useState } from 'react';

export interface SearchItem {
  id: string;
  title: string;
}

export function useSearchResults(query: string) {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setItems([]);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setIsLoading(true);

    fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: SearchItem[]) => {
        if (!cancelled) {
          setItems(data);
          setIsLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query]);

  return { items, isLoading };
}
