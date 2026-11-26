export interface ProfileDraft {
  headline: string;
  bio: string;
  location: string;
}

export interface ProfileValidationErrors {
  headline?: string;
  bio?: string;
}

export function validateProfileDraft(draft: ProfileDraft): ProfileValidationErrors {
  const errors: ProfileValidationErrors = {};
  if (draft.headline.trim().length < 3) {
    errors.headline = 'Headline must be at least 3 characters.';
  }
  if (draft.bio.trim().length > 500) {
    errors.bio = 'Bio cannot exceed 500 characters.';
  }
  return errors;
}

export function hasProfileChanges(initial: ProfileDraft, current: ProfileDraft): boolean {
  return initial.headline !== current.headline
    || initial.bio !== current.bio
    || initial.location !== current.location;
}
