import { enrichTemplateForList, type RawTemplateRow } from './template-service';

export function handleListTemplates(
  rows: readonly RawTemplateRow[],
  query: { readonly picker?: string; readonly q?: string },
) {
  const forPicker = query.picker === 'true';
  return {
    status: 200,
    body: { items: rows.map((row) => enrichTemplateForList(row, { forPicker, searchTerm: query.q })) },
  };
}
