import { fetchProfile } from './api-client';
import type { Profile } from './types';
export function loadProfile(id: string): Promise<Profile> {
  return fetchProfile(id);
}
