export async function fetchOrdersPage(baseUrl: string, accessToken: string, page: number) {
  const response = await fetch(`${baseUrl}/api/orders?page=${page}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (await response.json()) as { items: Array<{ id: string; status: string }>; hasMore: boolean };
}
