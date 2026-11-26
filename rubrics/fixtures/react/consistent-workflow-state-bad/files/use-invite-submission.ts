import { useState } from 'react';

export function useInviteSubmission(sendInvite: (email: string) => Promise<void>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submitInvite(email: string) {
    setIsSubmitting(true);
    try {
      await sendInvite(email);
      setIsSuccess(true);
      setIsSubmitting(false);
    } catch (error) {
      setIsError(true);
      setErrorMessage(error instanceof Error ? error.message : 'Failed');
    }
  }

  return { isSubmitting, isSuccess, isError, errorMessage, submitInvite };
}
