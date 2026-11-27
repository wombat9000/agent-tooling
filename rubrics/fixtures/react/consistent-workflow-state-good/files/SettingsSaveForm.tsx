import { useState } from 'react';

interface SettingsSaveFormProps {
  initialLabel: string;
  onSave: (label: string) => Promise<void>;
}

export function SettingsSaveForm({ initialLabel, onSave }: SettingsSaveFormProps) {
  const [label, setLabel] = useState(initialLabel);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function handleSubmit() {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await onSave(label.trim());
      setStatusMessage('Settings saved.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <input value={label} disabled={isSaving} onChange={(e) => setLabel(e.target.value)} />
      {statusMessage ? <p role="status">{statusMessage}</p> : null}
      <button type="submit" disabled={isSaving}>
        {isSaving ? 'Saving...' : 'Save'}
      </button>
    </form>
  );
}
