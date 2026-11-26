import { RecordCard } from './RecordCard';

export function RecordSummaryRow({ id, title }: { id: string; title: string }) {
  return (
    <RecordCard
      record={{ id, title }}
      isCompact
      hideHeader
      isReadOnly
      internalDraftStorageKey={`draft:${id}`}
      draftResetCounter={0}
      shouldHydrateDraftFromStorage={false}
      onAction={() => {}}
    />
  );
}
