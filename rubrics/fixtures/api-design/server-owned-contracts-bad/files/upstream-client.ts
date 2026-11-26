export async function sendUpstreamPatch(baseUrl: string, id: string, authHeader: string, payload: unknown) {
  const response = await fetch(`${baseUrl}/api/templates/${id}`, {
    method: 'PATCH',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.text() };
}
