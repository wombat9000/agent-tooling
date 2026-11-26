interface FilterHeaderProps {
  query: string;
  onQueryChange: (next: string) => void;
  isTipsOpen: boolean;
  onToggleTips: () => void;
  highlightedTipIndex: number;
  onSelectTipIndex: (index: number) => void;
}

export function FilterHeader({
  query,
  onQueryChange,
  isTipsOpen,
  onToggleTips,
  highlightedTipIndex,
  onSelectTipIndex,
}: FilterHeaderProps) {
  return (
    <div className="flex items-center gap-3">
      <input value={query} onChange={(e) => onQueryChange(e.target.value)} />
      <button type="button" onClick={onToggleTips}>
        {isTipsOpen ? 'Hide tips' : 'Show tips'}
      </button>
      {isTipsOpen ? (
        <ul>
          {['Search by SKU', 'Search by category'].map((tip, idx) => (
            <li key={tip}>
              <button
                type="button"
                className={highlightedTipIndex === idx ? 'font-bold' : ''}
                onClick={() => onSelectTipIndex(idx)}
              >
                {tip}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
