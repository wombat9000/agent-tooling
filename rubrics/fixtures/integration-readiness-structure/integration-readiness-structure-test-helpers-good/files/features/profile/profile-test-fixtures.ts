import type { Profile } from './types';
export function makeTestProfile(overrides: Partial<Profile> = {}): Profile {
  return { id: 'test-user-1', displayName: 'Test User', ...overrides };
}
