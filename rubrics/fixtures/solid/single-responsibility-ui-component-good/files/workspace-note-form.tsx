import { useState } from 'react';

export interface WorkspaceNoteFormProps {
  readonly initialBody: string;
  readonly isSaving: boolean;
  readonly onSave: (body: string) => void;
}

export function WorkspaceNoteForm({ initialBody, isSaving, onSave }: WorkspaceNoteFormProps) {
  const [draft, setDraft] = useState(initialBody);
  const isDirty = draft !== initialBody;

  const handleBlur = () => {
    if (!isDirty || isSaving) return;
    onSave(draft.trim());
  };

  return (
    <form className="note-form" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="note-fieldset" disabled={isSaving}>
        <label className="note-label" htmlFor="workspace-note">
          Shared notes
        </label>
        <textarea
          id="workspace-note"
          className="note-textarea"
          rows={4}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={handleBlur}
        />
        <p className="note-hint">{isSaving ? 'Saving...' : isDirty ? 'Unsaved changes' : 'Saved'}</p>
      </fieldset>
    </form>
  );
}
