export async function forwardGet(
  baseUrl: string,
  path: string,
  accessToken: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return { status: response.status, body: await response.text() };
}
