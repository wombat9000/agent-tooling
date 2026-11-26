import type { UserProfile } from './types';
export function canPublishProfile(profile: UserProfile): boolean { return profile.displayName.trim().length > 0; }
