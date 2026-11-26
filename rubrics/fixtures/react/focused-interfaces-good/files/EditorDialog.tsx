import { useState } from 'react';

type EditorDialogProps =
  | {
    mode: 'create';
    isSubmitting: boolean;
    onCreate: (title: string) => void;
    onClose: () => void;
  }
  | {
    mode: 'edit';
    itemId: string;
    initialTitle: string;
    isSubmitting: boolean;
    onUpdate: (itemId: string, title: string) => void;
    onClose: () => void;
  };

export function EditorDialog(props: EditorDialogProps) {
  const [title, setTitle] = useState(props.mode === 'edit' ? props.initialTitle : '');

  function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (props.mode === 'create') {
      props.onCreate(trimmed);
    } else {
      props.onUpdate(props.itemId, trimmed);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <h2>{props.mode === 'create' ? 'New item' : 'Edit item'}</h2>
      <input value={title} disabled={props.isSubmitting} onChange={(e) => setTitle(e.target.value)} />
      <button type="button" onClick={props.onClose}>Cancel</button>
      <button type="submit" disabled={props.isSubmitting}>Save</button>
    </form>
  );
}
