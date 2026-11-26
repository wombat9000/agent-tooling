import type { DocumentWorker } from './document-worker';

export async function archiveBatch(worker: DocumentWorker, ids: readonly string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const id of ids) {
    keys.push(await worker.archive(id));
  }
  return keys;
}
