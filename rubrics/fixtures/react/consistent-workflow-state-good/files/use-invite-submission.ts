import { useCallback, useState } from 'react';

export type InviteStatus =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'succeeded'; email: string }
  | { kind: 'failed'; message: string };

export function useInviteSubmission(sendInvite: (email: string) => Promise<void>) {
  const [status, setStatus] = useState<InviteStatus>({ kind: 'idle' });

  const submitInvite = useCallback(async (email: string): Promise<boolean> => {
    setStatus({ kind: 'submitting' });
    try {
      await sendInvite(email);
      setStatus({ kind: 'succeeded', email });
      return true;
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not send invite.',
      });
      return false;
    }
  }, [sendInvite]);

  const resetStatus = useCallback(() => setStatus({ kind: 'idle' }), []);

  return { status, submitInvite, resetStatus };
}
