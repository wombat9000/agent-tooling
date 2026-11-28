import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireSession = vi.fn();
const mockIsFeatureEnabled = vi.fn();

vi.mock('../auth/session.server', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock('../flags/unleash.server', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

import { action, loader } from '../context/case-detail.route';

describe('case-detail BFF route loader and action', () => {
  let upstreamServer: Server;
  let receivedDecisions: Array<{ caseId: string; decision: string; rationale: string }> = [];

  beforeAll(async () => {
    upstreamServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/cases/CASE-402') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'CASE-402',
          status: 'IN_REVIEW',
          title: 'Equipment reimbursement',
          auditEvents: [{ id: 'evt-1', action: 'SUBMITTED' }],
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/cases/CASE-402/decision') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const payload = JSON.parse(raw) as { decision: string; rationale: string };
          receivedDecisions.push({ caseId: 'CASE-402', ...payload });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'CASE-402', status: payload.decision === 'approve' ? 'APPROVED' : 'RETURNED' }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const address = upstreamServer.address();
    if (address && typeof address === 'object') {
      process.env.CASE_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  beforeEach(() => {
    receivedDecisions = [];
    mockRequireSession.mockResolvedValue({ userId: 'reviewer-1', accessToken: 'test-upstream-token' });
    mockIsFeatureEnabled.mockResolvedValue(true);
  });

  it('loads case details from the upstream HTTP service and maps audit timeline when enabled', async () => {
    const request = new Request('http://localhost/cases/CASE-402');

    const result = await loader({ request, params: { caseId: 'CASE-402' } });

    expect(result).toEqual({
      caseId: 'CASE-402',
      status: 'IN_REVIEW',
      title: 'Equipment reimbursement',
      auditEvents: [{ id: 'evt-1', action: 'SUBMITTED' }],
    });
  });

  it('validates form input and forwards approved decisions through the real upstream client', async () => {
    const body = new FormData();
    body.set('decision', 'approve');
    body.set('rationale', 'All required receipts verified');
    const request = new Request('http://localhost/cases/CASE-402', { method: 'POST', body });

    const response = await action({ request, params: { caseId: 'CASE-402' } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ caseId: 'CASE-402', status: 'APPROVED' });
    expect(receivedDecisions).toEqual([
      { caseId: 'CASE-402', decision: 'approve', rationale: 'All required receipts verified' },
    ]);
  });

  it('rejects missing rationale at the BFF validation boundary without calling upstream', async () => {
    const body = new FormData();
    body.set('decision', 'return');
    body.set('rationale', 'no');
    const request = new Request('http://localhost/cases/CASE-402', { method: 'POST', body });

    const response = await action({ request, params: { caseId: 'CASE-402' } });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe('VALIDATION_FAILED');
    expect(receivedDecisions).toEqual([]);
  });
});
