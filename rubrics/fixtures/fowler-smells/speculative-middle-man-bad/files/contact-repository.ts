import type { Contact } from './contact';

export class InMemoryContactRepository {
  private readonly items = new Map<string, Contact>();

  findById(id: string): Contact | null { return this.items.get(id) ?? null; }
  save(contact: Contact): void { this.items.set(contact.id, contact); }
  delete(id: string): void { this.items.delete(id); }
  listAll(): Contact[] { return [...this.items.values()]; }
}
