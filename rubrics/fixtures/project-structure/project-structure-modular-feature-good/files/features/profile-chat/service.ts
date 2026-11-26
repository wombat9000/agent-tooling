import { isNonEmptyMessage } from './decisions';
import type { ChatStore } from './store';
import type { ChatMessage } from './types';
export class ProfileChatService {
  constructor(private readonly store: ChatStore) {}
  async send(msg: ChatMessage): Promise<void> {
    if (!isNonEmptyMessage(msg)) throw new Error('Empty message');
    await this.store.append(msg);
  }
}
