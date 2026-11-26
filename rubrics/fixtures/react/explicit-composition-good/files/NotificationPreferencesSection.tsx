interface NotificationPreferencesSectionProps {
  digestEnabled: boolean;
  alertChannel: 'email' | 'sms';
  disabled: boolean;
  onDigestToggle: (enabled: boolean) => void;
  onAlertChannelChange: (channel: 'email' | 'sms') => void;
}

export function NotificationPreferencesSection({
  digestEnabled,
  alertChannel,
  disabled,
  onDigestToggle,
  onAlertChannelChange,
}: NotificationPreferencesSectionProps) {
  return (
    <section aria-labelledby="notifications-heading" className="rounded-lg border p-4 space-y-4">
      <h2 id="notifications-heading" className="text-lg font-medium">Notifications</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={digestEnabled}
          disabled={disabled}
          onChange={(event) => onDigestToggle(event.target.checked)}
        />
        Weekly summary digest
      </label>
      <div className="space-y-1">
        <label htmlFor="alert-channel" className="block text-sm font-medium">Urgent alerts</label>
        <select
          id="alert-channel"
          value={alertChannel}
          disabled={disabled}
          onChange={(event) => onAlertChannelChange(event.target.value as 'email' | 'sms')}
          className="rounded border px-3 py-2"
        >
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
      </div>
    </section>
  );
}
