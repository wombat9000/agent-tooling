import { useState } from 'react';
import type { AccountSettingsData } from './AccountSettingsScreen';

export function useAccountSettingsDraft(initial: AccountSettingsData) {
  const [settings, setSettings] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);

  function setDisplayName(displayName: string) {
    setSettings((prev) => ({ ...prev, displayName }));
  }

  function setDigestEnabled(digestEnabled: boolean) {
    setSettings((prev) => ({ ...prev, digestEnabled }));
  }

  function setAlertChannel(alertChannel: 'email' | 'sms') {
    setSettings((prev) => ({ ...prev, alertChannel }));
  }

  return {
    settings,
    isSaving,
    setIsSaving,
    setDisplayName,
    setDigestEnabled,
    setAlertChannel,
  };
}
