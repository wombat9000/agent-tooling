import { useState, type FormEvent } from 'react';
import { validateTitle } from './todo';

export function AddTodoForm({ onAdd }: { onAdd: (title: string) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateTitle(input);
    if (result.title === undefined) {
      setError(result.error);
      return;
    }

    onAdd(result.title);
    setInput('');
    setError('');
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="new-todo">New todo</label>
      <input
        id="new-todo"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'title-error' : undefined}
      />
      <button type="submit">Add todo</button>
      {error && <p id="title-error" role="alert">{error}</p>}
    </form>
  );
}
