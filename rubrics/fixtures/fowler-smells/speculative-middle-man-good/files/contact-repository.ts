import type { Contact } from './contact';

export interface ContactRepository {
  findByEmail(email: string): Promise<Contact | null>;
  save(contact: Contact): Promise<void>;
}
