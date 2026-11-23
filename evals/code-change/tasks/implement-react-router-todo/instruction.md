# Todo list

Build a TypeScript React app that uses React Router for client-side navigation.
The starter includes Vite, React Router, TypeScript, and Playwright. Use pnpm
and the installed dependencies. Store todos in the browser with localStorage.

## Routes

| URL | Link name | Todos shown |
| --- | --- | --- |
| `/` | All | All todos |
| `/active` | Active | Incomplete todos |
| `/completed` | Completed | Complete todos |

Show these links on every route and identify the current link with
`aria-current="page"`. All three URLs must work when opened directly or
reloaded, and browser Back and Forward must restore the corresponding filter.
Within each view, keep the order in which the visible todos were created. Show
an empty-state message with role `status` whenever the current filter has no
matches.

## Todo interactions

- Show the add form on every route. Give the text field the accessible name
  **New todo** and the submit button the name **Add todo**. The form must also
  submit with Enter in the field.
- Trim leading and trailing whitespace. Accept titles of 1 to 80 characters
  after trimming (measured using JavaScript string length). Reject blank and
  longer titles with a visible validation message with role `alert`. Leave the
  list unchanged after an invalid submission. Clear the field and validation
  message after a successful submission. Allow duplicate titles as independent todos.
- Start each new todo as incomplete. Keep the current URL on every mutation.
  A todo appears immediately when it matches the current filter.
- Show an accessible checkbox named for each todo's title. Checking it completes
  the todo and unchecking it reopens it. Filtered views update immediately.
- Show a button named **Delete {title}** for each todo. Delete only the
  corresponding item, even when two items have the same title.
- Titles, completion states, order, and deletions must persist on reload and
  when reopening the app in the same browser. A fresh browser starts empty.
  The storage key and format are up to you.

## Verification

Keep the app under `src/` and add Playwright tests under `tests/` that cover
normal use and an edge case. Check the app with `pnpm build` and `pnpm test`.
Use `pnpm dev` to run it locally.
