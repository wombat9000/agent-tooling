import type { KeyValueStore } from './storage';

export class ReadOnlyArchiveStore implements KeyValueStore {
  private readonly data: ReadonlyMap<string, string>;

  constructor(initial: ReadonlyMap<string, string>) {
    this.data = new Map(initial);
  }

  get(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  set(_key: string, _value: string): void {
    throw new Error('UnsupportedOperation: ReadOnlyArchiveStore is immutable');
  }

  delete(_key: string): void {
    throw new Error('UnsupportedOperation: ReadOnlyArchiveStore is immutable');
  }
}
