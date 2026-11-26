import { useEffect, useState } from 'react';

export interface SearchItem {
  id: string;
  title: string;
}

export function useSearchResults(query: string) {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setInterval(() => {
      setTick((value) => value + 1);
    }, 5_000);
  }, []);

  useEffect(() => {
    fetch(`/api/search?q=${encodeURIComponent(query)}`)
      .then((res) => res.json())
      .then((data: SearchItem[]) => {
        setItems(data);
      });
  }, [query]);

  return { items, tick };
}
