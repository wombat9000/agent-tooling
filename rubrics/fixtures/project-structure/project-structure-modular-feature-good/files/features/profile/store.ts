import type { UserProfile } from './types';
export interface ProfileStore { load(id: string): Promise<UserProfile | null>; save(profile: UserProfile): Promise<void>; }
