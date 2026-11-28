import { z } from 'zod';
import { requireSession } from '../auth/session.server';
import { isFeatureEnabled } from '../flags/unleash.server';
import { fetchCaseFromUpstream, submitCaseDecisionToUpstream } from '../clients/case-api.server';

const DecisionFormSchema = z.object({
  decision: z.enum(['approve', 'return']),
  rationale: z.string().trim().min(5),
});

export async function loader({ request, params }: { request: Request; params: { caseId: string } }) {
  const session = await requireSession(request);
  const showAuditTimeline = await isFeatureEnabled('case.audit-timeline', { userId: session.userId });
  const upstreamCase = await fetchCaseFromUpstream(params.caseId, session.accessToken);
  return {
    caseId: upstreamCase.id,
    status: upstreamCase.status,
    title: upstreamCase.title,
    auditEvents: showAuditTimeline ? upstreamCase.auditEvents : [],
  };
}

export async function action({ request, params }: { request: Request; params: { caseId: string } }) {
  const session = await requireSession(request);
  const form = await request.formData();
  const parsed = DecisionFormSchema.safeParse({
    decision: form.get('decision'),
    rationale: form.get('rationale'),
  });
  if (!parsed.success) {
    return Response.json({ error: 'VALIDATION_FAILED', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const updated = await submitCaseDecisionToUpstream(params.caseId, parsed.data, session.accessToken);
  return Response.json({ caseId: updated.id, status: updated.status }, { status: 200 });
}
