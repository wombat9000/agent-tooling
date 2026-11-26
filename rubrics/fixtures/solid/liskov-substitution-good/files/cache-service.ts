import type { ReadOnlyKeyStore, WritableKeyStore } from './storage';

export function readOrDefault(store: ReadOnlyKeyStore, key: string, fallback: string): string {
  return store.get(key) ?? fallback;
}

export function refreshCacheEntry(store: WritableKeyStore, key: string, value: string): void {
  store.set(key, value);
}
