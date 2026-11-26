import type { ChatMessage } from './types';
export function isNonEmptyMessage(msg: ChatMessage): boolean { return msg.body.trim().length > 0; }
