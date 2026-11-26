import type { MessageTemplateService } from './template-service';
import type { CreateMessageTemplateInput } from './template-types';

export async function handleListTemplates(service: MessageTemplateService) {
  const items = await service.listTemplates();
  return { status: 200, body: { items } };
}

export async function handleCreateTemplate(
  service: MessageTemplateService,
  payload: CreateMessageTemplateInput,
) {
  const created = await service.createTemplate(payload);
  return { status: 201, body: created };
}
