import {
  DIGEST_PREFERENCES,
  WORKFLOW_STEP_CODES,
  type DigestPreference,
  type OnboardingSubmissionRecord,
  type WorkflowStepCode,
} from './onboarding-contracts';

export interface OnboardingRepository {
  insert(record: OnboardingSubmissionRecord): Promise<void>;
}

export interface ControllerHttpRequest {
  readonly body: unknown;
}

export interface ControllerHttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function isWorkflowStepCode(value: unknown): value is WorkflowStepCode {
  return typeof value === 'string' && (WORKFLOW_STEP_CODES as readonly string[]).includes(value);
}

function isDigestPreference(value: unknown): value is DigestPreference {
  return typeof value === 'string' && (DIGEST_PREFERENCES as readonly string[]).includes(value);
}

export function createOnboardingController(
  repo: OnboardingRepository,
  createOpaqueId: () => string,
) {
  return async function handlePostSubmission(request: ControllerHttpRequest): Promise<ControllerHttpResponse> {
    if (!request.body || typeof request.body !== 'object') {
      return { status: 400, body: { error: 'Request body must be a JSON object' } };
    }
    const payload = request.body as Record<string, unknown>;
    const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim() : '';
    if (displayName.length < 2 || displayName.length > 80) {
      return { status: 400, body: { error: 'displayName must be between 2 and 80 characters' } };
    }
    if (!isWorkflowStepCode(payload.stepCode)) {
      return { status: 400, body: { error: 'Unsupported workflow stepCode' } };
    }
    if (payload.digestPreference !== undefined && !isDigestPreference(payload.digestPreference)) {
      return { status: 400, body: { error: 'Unsupported digestPreference' } };
    }
    const digestPreference: DigestPreference = payload.digestPreference ?? 'daily';

    const record: OnboardingSubmissionRecord = {
      id: createOpaqueId(),
      stepCode: payload.stepCode,
      digestPreference,
      displayName,
    };
    await repo.insert(record);
    return { status: 201, body: { submission: record } };
  };
}
