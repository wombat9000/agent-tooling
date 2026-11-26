// Validating payloads in the BFF keeps malformed writes off the upstream wire.
const ALLOWED_CHANNELS = new Set(['email', 'sms', 'push']);
const TEMPLATE_ID_PATTERN = /^emtpl_\d{2,6}$/;

export function validateAndFillTemplatePayload(raw: Record<string, unknown>) {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 3 || name.length > 120) {
    throw new Error('Template name must be between 3 and 120 characters');
  }
  const channel = typeof raw.channel === 'string' ? raw.channel : 'email';
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`Invalid channel: ${channel}`);
  }
  return {
    name,
    channel,
    category: typeof raw.category === 'string' ? raw.category : 'general',
    targetSubstages: Array.isArray(raw.targetSubstages) ? raw.targetSubstages : [],
    priority: typeof raw.priority === 'number' ? raw.priority : 2,
  };
}

export function isValidBackendTemplateId(id: string): boolean {
  return TEMPLATE_ID_PATTERN.test(id);
}

export function isDemoTemplateId(id: string): boolean {
  return id.startsWith('demo_emtpl_');
}
