import type { Contact } from './contact';

export interface ContactPipelinePlugin<TContext = Record<string, unknown>> {
  beforeSave?(contact: Contact, context: TContext): Contact;
  afterSave?(contact: Contact, context: TContext): void;
  onFutureSyncHook?(batch: readonly Contact[]): Promise<void>;
}

export abstract class AbstractContactPersistenceStrategy {
  abstract persist(contact: Contact): void;
}

export class DefaultContactPersistenceStrategy extends AbstractContactPersistenceStrategy {
  private readonly onPersist: (contact: Contact) => void;
  constructor(onPersist: (contact: Contact) => void) {
    super();
    this.onPersist = onPersist;
  }
  persist(contact: Contact): void { this.onPersist(contact); }
}

export function createContactStrategy(kind: 'default', onPersist: (contact: Contact) => void): AbstractContactPersistenceStrategy {
  if (kind === 'default') return new DefaultContactPersistenceStrategy(onPersist);
  throw new Error(`Unsupported strategy: ${String(kind)}`);
}
