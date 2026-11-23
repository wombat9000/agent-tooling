import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { AddTodoForm } from './AddTodoForm';
import { TodoList } from './TodoList';
import { visibleTodos, type Todo, type TodoFilter } from './todo';
import { readTodos, writeTodos } from './todoStorage';

const views = [
  { path: '/', label: 'All', filter: 'all' },
  { path: '/active', label: 'Active', filter: 'active' },
  { path: '/completed', label: 'Completed', filter: 'completed' },
] as const;

export function TodoApp() {
  const [todos, setTodos] = useState(() => readTodos(localStorage));

  useEffect(() => {
    writeTodos(localStorage, todos);
  }, [todos]);

  function addTodo(title: string) {
    const todo: Todo = { id: crypto.randomUUID(), title, completed: false };
    setTodos((current) => [...current, todo]);
  }

  function changeCompletion(id: string, completed: boolean) {
    setTodos((current) => current.map((todo) =>
      todo.id === id ? { ...todo, completed } : todo));
  }

  function deleteTodo(id: string) {
    setTodos((current) => current.filter((todo) => todo.id !== id));
  }

  function listFor(filter: TodoFilter) {
    return (
      <TodoList
        todos={visibleTodos(todos, filter)}
        onChange={changeCompletion}
        onDelete={deleteTodo}
      />
    );
  }

  return (
    <main>
      <h1>Todo list</h1>
      <AddTodoForm onAdd={addTodo} />
      <nav aria-label="Todo filters">
        {views.map(({ path, label }) => <NavLink key={path} to={path} end>{label}</NavLink>)}
      </nav>
      <Routes>
        {views.map(({ path, filter }) => <Route key={path} path={path} element={listFor(filter)} />)}
      </Routes>
    </main>
  );
}
