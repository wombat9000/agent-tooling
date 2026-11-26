import type { ChatMessage } from './types';
export interface ChatStore { append(msg: ChatMessage): Promise<void>; }
