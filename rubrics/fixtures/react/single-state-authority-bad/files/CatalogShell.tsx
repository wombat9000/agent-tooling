import { CatalogPanel } from './CatalogPanel';

interface CatalogShellProps {
  title: string;
  items: Array<{ id: string; name: string }>;
  query: string;
  onQueryChange: (next: string) => void;
  isTipsOpen: boolean;
  onToggleTips: () => void;
  highlightedTipIndex: number;
  onSelectTipIndex: (index: number) => void;
}

export function CatalogShell({
  title,
  items,
  query,
  onQueryChange,
  isTipsOpen,
  onToggleTips,
  highlightedTipIndex,
  onSelectTipIndex,
}: CatalogShellProps) {
  return (
    <div className="mx-auto max-w-4xl p-6 space-y-4">
      <h1>{title}</h1>
      <CatalogPanel
        items={items}
        query={query}
        onQueryChange={onQueryChange}
        isTipsOpen={isTipsOpen}
        onToggleTips={onToggleTips}
        highlightedTipIndex={highlightedTipIndex}
        onSelectTipIndex={onSelectTipIndex}
      />
    </div>
  );
}
