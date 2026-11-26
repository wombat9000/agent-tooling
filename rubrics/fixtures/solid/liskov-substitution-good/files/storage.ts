export interface ReadOnlyKeyStore {
  get(key: string): string | null;
}

export interface WritableKeyStore extends ReadOnlyKeyStore {
  set(key: string, value: string): void;
  delete(key: string): void;
}
