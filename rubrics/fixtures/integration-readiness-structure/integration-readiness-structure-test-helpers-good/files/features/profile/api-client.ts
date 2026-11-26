import { fetchJson } from '../../lib/http-client';
import type { Profile } from './types';
export function fetchProfile(id: string): Promise<Profile> {
  return fetchJson<Profile>(`/api/profiles/${id}`);
}
