import { ReadOnlyArchiveStore } from './read-only-archive-store';
import type { KeyValueStore } from './storage';

export function syncCacheValue(store: KeyValueStore, key: string, value: string): boolean {
  if (store instanceof ReadOnlyArchiveStore) {
    return false;
  }
  store.set(key, value);
  return true;
}
