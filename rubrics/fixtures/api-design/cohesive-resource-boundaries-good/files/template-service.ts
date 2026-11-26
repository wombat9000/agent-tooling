import type { CreateMessageTemplateInput, MessageTemplateDto } from './template-types';

export interface TemplateStore {
  list(): Promise<readonly MessageTemplateDto[]>;
  insert(input: CreateMessageTemplateInput): Promise<MessageTemplateDto>;
}

export class MessageTemplateService {
  private readonly store: TemplateStore;

  constructor(store: TemplateStore) {
    this.store = store;
  }

  listTemplates(): Promise<readonly MessageTemplateDto[]> {
    return this.store.list();
  }

  createTemplate(input: CreateMessageTemplateInput): Promise<MessageTemplateDto> {
    return this.store.insert(input);
  }
}
