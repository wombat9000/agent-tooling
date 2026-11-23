import type { Todo } from './todo';

type TodoListProps = {
  todos: readonly Todo[];
  onChange: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
};

export function TodoList({ todos, onChange, onDelete }: TodoListProps) {
  if (todos.length === 0) return <p role="status">No todos to show.</p>;

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          <label>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={(event) => onChange(todo.id, event.target.checked)}
            />
            {todo.title}
          </label>
          <button type="button" onClick={() => onDelete(todo.id)}>
            Delete {todo.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
