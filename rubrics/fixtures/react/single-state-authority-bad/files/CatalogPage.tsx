import { useEffect, useState } from 'react';
import { CatalogShell } from './CatalogShell';

interface CatalogPageProps {
  searchParams: URLSearchParams;
  onSearchParamsChange: (next: URLSearchParams) => void;
  loaderItems: Array<{ id: string; name: string }>;
}

export function CatalogPage({
  searchParams,
  onSearchParamsChange,
  loaderItems,
}: CatalogPageProps) {
  // Duplicate authorities for URL search params and route loader data
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [items, setItems] = useState(loaderItems);
  // Leaf-only UI tooltip state hoisted to top page and drilled through 2 pass-through shells
  const [isTipsOpen, setIsTipsOpen] = useState(false);
  const [highlightedTipIndex, setHighlightedTipIndex] = useState(0);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (query) next.set('q', query);
    else next.delete('q');
    onSearchParamsChange(next);
  }, [query]);

  function handleFilterLocal(nextQuery: string) {
    setQuery(nextQuery);
    setItems(loaderItems.filter((item) => item.name.toLowerCase().includes(nextQuery.toLowerCase())));
  }

  return (
    <CatalogShell
      title="Catalog"
      items={items}
      query={query}
      onQueryChange={handleFilterLocal}
      isTipsOpen={isTipsOpen}
      onToggleTips={() => setIsTipsOpen((open) => !open)}
      highlightedTipIndex={highlightedTipIndex}
      onSelectTipIndex={setHighlightedTipIndex}
    />
  );
}
