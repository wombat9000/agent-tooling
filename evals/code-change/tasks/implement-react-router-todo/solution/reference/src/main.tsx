import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { TodoApp } from './TodoApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <TodoApp />
  </BrowserRouter>,
);
