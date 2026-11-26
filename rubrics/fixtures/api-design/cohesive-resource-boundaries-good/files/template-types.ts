export interface MessageTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly folderLabel: string | null;
  readonly updatedAtIso: string;
}

export interface CreateMessageTemplateInput {
  readonly name: string;
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly folderLabel?: string | null;
}
