import type { DocumentArchiver } from './document-ports';

export async function archiveBatch(archiver: DocumentArchiver, ids: readonly string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const id of ids) {
    keys.push(await archiver.archive(id));
  }
  return keys;
}
