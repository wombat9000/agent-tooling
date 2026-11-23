import { expect, test } from '@playwright/test';

async function addTodo(page, title) {
  await page.getByRole('textbox', { name: 'New todo' }).fill(title);
  await page.getByRole('button', { name: 'Add todo' }).click();
}

function todo(page, title) {
  return page.getByRole('checkbox', { name: title, exact: true });
}

function filterLink(page, label) {
  return page.getByRole('link', { name: new RegExp(`^${label}\\b`) });
}

test('creates trimmed titles in order and validates the title bounds', async ({ page }) => {
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'New todo' });
  const items = page.getByRole('checkbox');

  await expect(page.getByRole('status')).toBeVisible();
  await addTodo(page, '   ');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(items).toHaveCount(0);

  await field.fill('  Buy oat milk  ');
  await field.press('Enter');
  await expect(todo(page, 'Buy oat milk')).not.toBeChecked();
  await expect(page.getByRole('status')).not.toBeVisible();
  await expect(field).toBeEmpty();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await addTodo(page, 'x'.repeat(81));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(items).toHaveCount(1);

  const longestTitle = 'y'.repeat(80);
  await addTodo(page, `  ${longestTitle}  `);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAccessibleName('Buy oat milk');
  await expect(items.nth(1)).toHaveAccessibleName(longestTitle);
  await expect(todo(page, longestTitle)).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(field).toBeEmpty();
});

test('keeps the route and immediately applies each filter after mutations', async ({ page }) => {
  await page.goto('/active');
  await expect(filterLink(page, 'Active')).toHaveAttribute('aria-current', 'page');
  await addTodo(page, 'Pack lunch');
  await expect(todo(page, 'Pack lunch')).toBeVisible();
  await expect(page.getByRole('status')).not.toBeVisible();
  await todo(page, 'Pack lunch').click();
  await expect(todo(page, 'Pack lunch')).toHaveCount(0);
  await expect(page.getByRole('status')).toBeVisible();
  await expect(page).toHaveURL('/active');

  await filterLink(page, 'Completed').click();
  await expect(page).toHaveURL('/completed');
  await expect(filterLink(page, 'Completed')).toHaveAttribute('aria-current', 'page');
  await expect(todo(page, 'Pack lunch')).toBeChecked();

  await addTodo(page, 'Wash the dishes');
  await expect(page).toHaveURL('/completed');
  await expect(todo(page, 'Wash the dishes')).toHaveCount(0);
  await todo(page, 'Pack lunch').click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL('/active');
  await expect(todo(page, 'Pack lunch')).not.toBeChecked();
  await expect(todo(page, 'Wash the dishes')).not.toBeChecked();

  await page.goForward();
  await expect(page).toHaveURL('/completed');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await filterLink(page, 'All').click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('checkbox')).toHaveCount(2);
});

test('persists order, independent duplicate titles, completion, and deletion across pages', async ({ page, context }) => {
  await page.goto('/');
  await addTodo(page, 'Return the book');
  await addTodo(page, 'Return the book');
  await addTodo(page, 'Book a table');
  const duplicates = todo(page, 'Return the book');
  await expect(duplicates).toHaveCount(2);
  await duplicates.first().check();
  await expect(duplicates.last()).not.toBeChecked();

  await page.reload();
  await expect(duplicates.first()).toBeChecked();
  await expect(duplicates.last()).not.toBeChecked();
  await expect(page.getByRole('checkbox').last()).toHaveAccessibleName('Book a table');
  await page.getByRole('button', { name: 'Delete Return the book', exact: true }).last().click();
  await expect(duplicates).toHaveCount(1);
  await expect(duplicates).toBeChecked();

  const reopened = await context.newPage();
  await reopened.goto('/completed');
  await expect(todo(reopened, 'Return the book')).toBeChecked();
  await expect(todo(reopened, 'Book a table')).toHaveCount(0);
  await reopened.reload();
  await expect(todo(reopened, 'Return the book')).toBeChecked();

  await page.goto('/');
  await expect(duplicates).toHaveCount(1);
  await expect(todo(page, 'Book a table')).not.toBeChecked();
});
