import { canPublishProfile } from './decisions';
import type { ProfileStore } from './store';
import type { UserProfile } from './types';
export class ProfileService {
  constructor(private readonly store: ProfileStore) {}
  async publish(profile: UserProfile): Promise<void> {
    if (!canPublishProfile(profile)) throw new Error('Invalid profile');
    await this.store.save(profile);
  }
}
