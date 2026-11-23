import type { Todo } from './todo';

const storageKey = 'todos';

function isTodo(value: unknown): value is Todo {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string'
    && 'title' in value && typeof value.title === 'string'
    && 'completed' in value && typeof value.completed === 'boolean';
}

export function readTodos(storage: Storage): Todo[] {
  const stored = storage.getItem(storageKey);
  if (stored === null) return [];

  try {
    const decoded: unknown = JSON.parse(stored);
    return Array.isArray(decoded) ? decoded.filter(isTodo) : [];
  } catch {
    return [];
  }
}

export function writeTodos(storage: Storage, todos: readonly Todo[]) {
  storage.setItem(storageKey, JSON.stringify(todos));
}
