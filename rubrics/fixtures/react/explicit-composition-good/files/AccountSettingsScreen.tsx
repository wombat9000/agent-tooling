import { ProfileDetailsSection } from './ProfileDetailsSection';
import { NotificationPreferencesSection } from './NotificationPreferencesSection';

export interface AccountSettingsData {
  displayName: string;
  contactEmail: string;
  digestEnabled: boolean;
  alertChannel: 'email' | 'sms';
}

interface AccountSettingsScreenProps {
  settings: AccountSettingsData;
  isSaving: boolean;
  onDisplayNameChange: (value: string) => void;
  onDigestToggle: (enabled: boolean) => void;
  onAlertChannelChange: (channel: 'email' | 'sms') => void;
  onSubmit: () => void;
}

export function AccountSettingsScreen({
  settings,
  isSaving,
  onDisplayNameChange,
  onDigestToggle,
  onAlertChannelChange,
  onSubmit,
}: AccountSettingsScreenProps) {
  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="text-sm text-slate-600">Manage profile identity and notification delivery.</p>
      </header>

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <ProfileDetailsSection
          displayName={settings.displayName}
          contactEmail={settings.contactEmail}
          disabled={isSaving}
          onDisplayNameChange={onDisplayNameChange}
        />

        <NotificationPreferencesSection
          digestEnabled={settings.digestEnabled}
          alertChannel={settings.alertChannel}
          disabled={isSaving}
          onDigestToggle={onDigestToggle}
          onAlertChannelChange={onAlertChannelChange}
        />

        <div className="flex justify-end">
          <button type="submit" disabled={isSaving} className="rounded-md bg-slate-900 px-4 py-2 text-white">
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </main>
  );
}
