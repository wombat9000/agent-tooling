import { useState } from 'react';

export interface AccountPreferencesDraft {
  readonly workspaceLabel: string;
  readonly timezone: string;
  readonly locale: string;
  readonly digestFrequency: 'daily' | 'weekly' | 'off';
  readonly securityAlerts: boolean;
  readonly releaseNotes: boolean;
}

interface AccountPreferencesFormProps {
  readonly initial: AccountPreferencesDraft;
  readonly timezones: readonly string[];
  readonly locales: readonly string[];
  readonly onSave: (draft: AccountPreferencesDraft) => Promise<void>;
  readonly onReset: () => void;
}

export function AccountPreferencesForm({
  initial,
  timezones,
  locales,
  onSave,
  onReset,
}: AccountPreferencesFormProps) {
  const [draft, setDraft] = useState<AccountPreferencesDraft>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const updateField = <K extends keyof AccountPreferencesDraft>(
    key: K,
    value: AccountPreferencesDraft[K],
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setStatusMessage(null);
  };

  async function handleSubmit() {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await onSave(draft);
      setStatusMessage('Preferences saved.');
    } finally {
      setIsSaving(false);
    }
  }

  function handleReset() {
    setDraft(initial);
    setStatusMessage(null);
    onReset();
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Account preferences</h2>
        <p className="text-sm text-slate-600">Configure regional defaults and email notifications for your account.</p>
      </header>

      <section aria-labelledby="pref-identity" className="space-y-3 rounded border p-4">
        <h3 id="pref-identity" className="text-sm font-medium">Workspace identity</h3>
        <div>
          <label htmlFor="pref-label" className="block text-sm">Display label</label>
          <input
            id="pref-label"
            value={draft.workspaceLabel}
            disabled={isSaving}
            onChange={(e) => updateField('workspaceLabel', e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
      </section>

      <section aria-labelledby="pref-region" className="space-y-3 rounded border p-4">
        <h3 id="pref-region" className="text-sm font-medium">Regional settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="pref-timezone" className="block text-sm">Timezone</label>
            <select
              id="pref-timezone"
              value={draft.timezone}
              disabled={isSaving}
              onChange={(e) => updateField('timezone', e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pref-locale" className="block text-sm">Language</label>
            <select
              id="pref-locale"
              value={draft.locale}
              disabled={isSaving}
              onChange={(e) => updateField('locale', e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              {locales.map((loc) => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <fieldset disabled={isSaving} className="space-y-3 rounded border p-4">
        <legend className="text-sm font-medium">Notification delivery</legend>
        <div>
          <label htmlFor="pref-digest" className="block text-sm">Activity digest</label>
          <select
            id="pref-digest"
            value={draft.digestFrequency}
            onChange={(e) => updateField('digestFrequency', e.target.value as AccountPreferencesDraft['digestFrequency'])}
            className="mt-1 rounded border px-3 py-2"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="off">Off</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.securityAlerts}
            onChange={(e) => updateField('securityAlerts', e.target.checked)}
          />
          Email security alerts
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.releaseNotes}
            onChange={(e) => updateField('releaseNotes', e.target.checked)}
          />
          Product release notes
        </label>
      </fieldset>

      {statusMessage ? <p role="status" className="text-sm text-emerald-700">{statusMessage}</p> : null}

      <footer className="flex justify-end gap-2">
        <button type="button" disabled={isSaving} onClick={handleReset} className="rounded border px-4 py-2">
          Reset
        </button>
        <button type="submit" disabled={isSaving} className="rounded bg-slate-900 px-4 py-2 text-white">
          {isSaving ? 'Saving...' : 'Save preferences'}
        </button>
      </footer>
    </form>
  );
}
