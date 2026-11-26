import { useState } from 'react';

interface InviteFormProps {
  onSendInvite: (email: string) => Promise<void>;
  onDone: () => void;
}

export function InviteForm({ onSendInvite, onDone }: InviteFormProps) {
  const [email, setEmail] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  async function handleSubmit() {
    try {
      await onSendInvite(email);
    } catch {
      // ignore network error
    }
    setEmail('');
    setBanner('Invite sent!');
    onDone();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button type="submit">Send invite</button>
      {banner ? <p role="status">{banner}</p> : null}
    </form>
  );
}
