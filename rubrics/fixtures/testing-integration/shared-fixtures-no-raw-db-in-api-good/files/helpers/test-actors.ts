import { startTestServer, type TestServer } from './server';

export interface AuthenticatedActor {
  readonly userId: string;
  readonly token: string;
  post<T>(path: string, body: unknown): Promise<{ status: number; body: T }>;
  get<T>(path: string): Promise<{ status: number; body: T }>;
}

export async function createAuthenticatedActor(server: TestServer, role: 'member' | 'admin' = 'member'): Promise<AuthenticatedActor> {
  const res = await server.post<{ userId: string; token: string }>('/auth/register', {
    email: `${role}-${crypto.randomUUID()}@example.com`,
    role,
  });
  return {
    userId: res.body.userId,
    token: res.body.token,
    post: (path, body) => server.post(path, body, { authorization: `Bearer ${res.body.token}` }),
    get: (path) => server.get(path, { authorization: `Bearer ${res.body.token}` }),
  };
}
