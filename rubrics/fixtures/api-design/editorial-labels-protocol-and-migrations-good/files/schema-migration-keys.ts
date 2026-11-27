export const RETIRED_V1_SCHEMA_KEYS = [
  'category',
  'folderName',
  'legacySection',
  'oldTagGroup',
] as const;

export type RetiredV1SchemaKey = (typeof RETIRED_V1_SCHEMA_KEYS)[number];

const RETIRED_KEY_SET = new Set<string>(RETIRED_V1_SCHEMA_KEYS);

export function assertNoRetiredSchemaFields(payload: Record<string, unknown>): void {
  const found = Object.keys(payload).filter((key) => RETIRED_KEY_SET.has(key));
  if (found.length > 0) {
    throw new Error(`Retired v1 schema fields are no longer accepted: ${found.join(', ')}`);
  }
}

export function stripRetiredSchemaFields(payload: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!RETIRED_KEY_SET.has(key)) {
      migrated[key] = value;
    }
  }
  return migrated;
}
