import { createElement } from 'react';
import axios from 'axios';

export async function CatalogTable({ warehouseUrl }: { warehouseUrl: string }) {
  const response = await axios.get(`${warehouseUrl}/inventory`);
  const rows = Array.isArray(response.data) ? response.data : [];
  return createElement('ul', null, rows.length);
}
