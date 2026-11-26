import { isDemoTemplateId, isValidBackendTemplateId, validateAndFillTemplatePayload } from './template-validator';
import { sendUpstreamPatch } from './upstream-client';

export async function handlePatchTemplateProxy(
  baseUrl: string,
  authHeader: string | null,
  templateId: string,
  rawBody: Record<string, unknown>,
) {
  if (!authHeader) return { status: 401, body: 'Unauthorized' };
  if (isDemoTemplateId(templateId) || !isValidBackendTemplateId(templateId)) {
    return { status: 400, body: 'Invalid template ID prefix' };
  }
  const normalized = validateAndFillTemplatePayload(rawBody);
  return sendUpstreamPatch(baseUrl, templateId, authHeader, normalized);
}
