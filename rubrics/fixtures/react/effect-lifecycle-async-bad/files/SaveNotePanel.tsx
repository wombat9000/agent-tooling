import { useEffect, useState } from 'react';

interface SaveNotePanelProps {
  noteId: string;
  onSave: (noteId: string, body: string) => Promise<void>;
}

export function SaveNotePanel({ noteId, onSave }: SaveNotePanelProps) {
  const [body, setBody] = useState('');
  const [shouldSave, setShouldSave] = useState(false);

  useEffect(() => {
    window.addEventListener('keydown', (event) => {
      if (event.metaKey && event.key === 's') {
        event.preventDefault();
        setShouldSave(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!shouldSave) return;
    setShouldSave(false);
    void onSave(noteId, body);
  }, [shouldSave, noteId, body, onSave]);

  return (
    <div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      <button type="button" onClick={() => setShouldSave(true)}>
        Save note
      </button>
    </div>
  );
}
