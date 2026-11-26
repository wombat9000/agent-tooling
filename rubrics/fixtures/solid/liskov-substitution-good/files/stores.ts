import type { ReadOnlyKeyStore, WritableKeyStore } from './storage';

export class MemoryKeyStore implements WritableKeyStore {
  private readonly entries = new Map<string, string>();
  get(key: string): string | null { return this.entries.get(key) ?? null; }
  set(key: string, value: string): void { this.entries.set(key, value); }
  delete(key: string): void { this.entries.delete(key); }
}

export class SnapshotKeyStore implements ReadOnlyKeyStore {
  private readonly snapshot: ReadonlyMap<string, string>;
  constructor(initial: ReadonlyMap<string, string>) {
    this.snapshot = new Map(initial);
  }
  get(key: string): string | null { return this.snapshot.get(key) ?? null; }
}
