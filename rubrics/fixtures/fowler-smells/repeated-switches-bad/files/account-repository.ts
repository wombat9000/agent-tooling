import type { AccountSummary } from './types';

export interface AccountRepository {
  findById(accountId: string): Promise<AccountSummary | null>;
}
