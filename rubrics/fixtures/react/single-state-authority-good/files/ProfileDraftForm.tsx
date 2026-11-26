import { useState } from 'react';

export interface ProfileSnapshot {
  headline: string;
  summary: string;
}

interface ProfileDraftFormProps {
  initialProfile: ProfileSnapshot;
  onSave: (draft: ProfileSnapshot) => Promise<void>;
}

export function ProfileDraftForm({ initialProfile, onSave }: ProfileDraftFormProps) {
  const [headline, setHeadline] = useState(initialProfile.headline);
  const [summary, setSummary] = useState(initialProfile.summary);

  function handleCancel() {
    setHeadline(initialProfile.headline);
    setSummary(initialProfile.summary);
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ headline, summary });
      }}
    >
      <input value={headline} onChange={(e) => setHeadline(e.target.value)} />
      <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
      <div className="flex gap-2">
        <button type="button" onClick={handleCancel}>Cancel</button>
        <button type="submit">Apply changes</button>
      </div>
    </form>
  );
}
