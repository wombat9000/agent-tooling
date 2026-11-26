import { normalizeContactEmail, type Contact } from './contact';
import type { ContactRepository } from './contact-repository';

export class ContactService {
  private readonly repo: ContactRepository;

  constructor(repo: ContactRepository) {
    this.repo = repo;
  }

  async registerContact(input: { readonly id: string; readonly email: string; readonly company: string }): Promise<Contact> {
    const email = normalizeContactEmail(input.email);
    const existing = await this.repo.findByEmail(email);
    if (existing) {
      throw new Error(`Contact already registered: ${email}`);
    }
    const contact: Contact = { id: input.id, email, company: input.company.trim() };
    await this.repo.save(contact);
    return contact;
  }
}
