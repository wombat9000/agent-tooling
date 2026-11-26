import type { CaseSnapshot } from './workflow-states';

export interface CaseRepository {
  save(snapshot: CaseSnapshot): Promise<void>;
}
