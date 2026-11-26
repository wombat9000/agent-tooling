import type { Contact } from './contact';
import type { InMemoryContactRepository } from './contact-repository';

export class ContactManager {
  private readonly repo: InMemoryContactRepository;

  constructor(repo: InMemoryContactRepository) {
    this.repo = repo;
  }

  findById(id: string): Contact | null { return this.repo.findById(id); }
  save(contact: Contact): void { this.repo.save(contact); }
  delete(id: string): void { this.repo.delete(id); }
  listAll(): Contact[] { return this.repo.listAll(); }
}
