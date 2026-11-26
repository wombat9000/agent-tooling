import type { Profile } from '../types';
export function createMockProfileTransport(profile: Profile) {
  return async () => profile;
}
