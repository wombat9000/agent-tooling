export type TaskStage = 'queued' | 'active' | 'done';

export interface TaskCard {
  readonly id: string;
  readonly title: string;
  readonly stage: TaskStage;
}

interface StatusBoardViewProps {
  readonly cards: readonly TaskCard[];
  readonly onSelect: (id: string) => void;
}

const COLUMNS: readonly { readonly stage: TaskStage; readonly label: string }[] = [
  { stage: 'queued', label: 'Queued' },
  { stage: 'active', label: 'Active' },
  { stage: 'done', label: 'Done' },
];

export function StatusBoardView({ cards, onSelect }: StatusBoardViewProps) {
  return (
    <div className="grid grid-cols-3 gap-4">
      {COLUMNS.map((column) => {
        const items = cards.filter((card) => card.stage === column.stage);
        return (
          <section key={column.stage} className="rounded border p-3 space-y-2">
            <header className="flex justify-between text-sm font-medium">
              <h2>{column.label}</h2>
              <span>{items.length}</span>
            </header>
            {items.length === 0 ? (
              <p className="text-xs text-slate-500">No items</p>
            ) : (
              <ul className="space-y-1">
                {items.map((card) => (
                  <li key={card.id}>
                    <button type="button" onClick={() => onSelect(card.id)} className="w-full text-left text-sm">
                      {card.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
