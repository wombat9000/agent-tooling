import { FilterHeader } from './FilterHeader';

interface CatalogPanelProps {
  items: Array<{ id: string; name: string }>;
  query: string;
  onQueryChange: (next: string) => void;
  isTipsOpen: boolean;
  onToggleTips: () => void;
  highlightedTipIndex: number;
  onSelectTipIndex: (index: number) => void;
}

export function CatalogPanel({
  items,
  query,
  onQueryChange,
  isTipsOpen,
  onToggleTips,
  highlightedTipIndex,
  onSelectTipIndex,
}: CatalogPanelProps) {
  return (
    <section className="rounded border p-4 space-y-4">
      <FilterHeader
        query={query}
        onQueryChange={onQueryChange}
        isTipsOpen={isTipsOpen}
        onToggleTips={onToggleTips}
        highlightedTipIndex={highlightedTipIndex}
        onSelectTipIndex={onSelectTipIndex}
      />
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </section>
  );
}
