import { useCallback, useMemo, useState } from 'react';
import {
  hasProfileChanges,
  validateProfileDraft,
  type ProfileDraft,
} from './profile-validation';

export function useProfileEditor(
  initialProfile: ProfileDraft,
  saveProfile: (draft: ProfileDraft) => Promise<void>,
) {
  const [draft, setDraft] = useState<ProfileDraft>(initialProfile);
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const errors = useMemo(() => validateProfileDraft(draft), [draft]);
  const isDirty = useMemo(() => hasProfileChanges(initialProfile, draft), [initialProfile, draft]);
  const canSave = isDirty && Object.keys(errors).length === 0 && !isSaving;

  const updateField = useCallback(<K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setSubmitError(null);
  }, []);

  const reset = useCallback(() => {
    setDraft(initialProfile);
    setSubmitError(null);
  }, [initialProfile]);

  const submit = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    setSubmitError(null);
    try {
      await saveProfile(draft);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to save profile');
    } finally {
      setIsSaving(false);
    }
  }, [canSave, draft, saveProfile]);

  return {
    draft,
    errors,
    isDirty,
    isSaving,
    canSave,
    submitError,
    updateField,
    reset,
    submit,
  };
}
