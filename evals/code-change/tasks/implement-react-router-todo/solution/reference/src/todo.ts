export type Todo = Readonly<{
  id: string;
  title: string;
  completed: boolean;
}>;

export type TodoFilter = 'all' | 'active' | 'completed';

const maxTitleLength = 80;

export function validateTitle(input: string) {
  const title = input.trim();
  if (!title) return { error: 'Enter a title for the todo.' };
  if (title.length > maxTitleLength) return { error: 'Use 80 characters or fewer.' };
  return { title };
}

export function visibleTodos(todos: readonly Todo[], filter: TodoFilter) {
  switch (filter) {
    case 'all':
      return todos;
    case 'active':
      return todos.filter((todo) => !todo.completed);
    case 'completed':
      return todos.filter((todo) => todo.completed);
  }
}
