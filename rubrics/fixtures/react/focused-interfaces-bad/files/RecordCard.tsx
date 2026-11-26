import { useEffect, useState } from 'react';

export interface RecordCardProps {
  record: Record<string, unknown>;
  isCompact?: boolean;
  isExpanded?: boolean;
  isEditing?: boolean;
  isReadOnly?: boolean;
  isAdminView?: boolean;
  hideHeader?: boolean;
  showFooter?: boolean;
  showInlineAuditTrail?: boolean;
  internalDraftStorageKey: string;
  draftResetCounter: number;
  shouldHydrateDraftFromStorage: boolean;
  extraConfig?: {
    exportCsvHeaders?: string[];
    billingCurrency?: string;
    highlightThreshold?: number;
  };
  onAction: (actionType: string, payload?: unknown) => void;
}

export function RecordCard({
  record,
  isCompact,
  isExpanded,
  isEditing,
  isReadOnly,
  isAdminView,
  hideHeader,
  showFooter,
  showInlineAuditTrail,
  internalDraftStorageKey,
  draftResetCounter,
  shouldHydrateDraftFromStorage,
  extraConfig,
  onAction,
}: RecordCardProps) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (shouldHydrateDraftFromStorage) {
      setDraft(window.localStorage.getItem(internalDraftStorageKey) ?? '');
    } else {
      setDraft('');
    }
  }, [internalDraftStorageKey, draftResetCounter, shouldHydrateDraftFromStorage]);

  return (
    <article className={isCompact && !isExpanded ? 'p-2' : 'p-6'}>
      {!hideHeader && !isCompact ? (
        <header>
          <h3>{String(record.title ?? '')}</h3>
          {isAdminView && !isReadOnly ? (
            <button type="button" onClick={() => onAction('toggle_lock', record.id)}>Lock</button>
          ) : null}
        </header>
      ) : null}

      {isEditing && !isReadOnly ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <p>{String(record.summary ?? '')}</p>
      )}

      {showInlineAuditTrail && isAdminView ? (
        <div>Threshold: {extraConfig?.highlightThreshold ?? 0}</div>
      ) : null}

      {showFooter ? (
        <footer>
          {isEditing && !isReadOnly ? (
            <button type="button" onClick={() => onAction('save_draft', { id: record.id, draft })}>Save</button>
          ) : null}
          {extraConfig?.exportCsvHeaders ? (
            <button type="button" onClick={() => onAction('export_csv', extraConfig.exportCsvHeaders)}>Export</button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
