import { test, expect } from '@playwright/test';

for (const [outcome, reason] of [
  ['lock', 'onboarding credential delivery is in progress or awaiting administrator review'],
  ['stale', 'This record has changed.'],
  ['unknown', 'Employee details could not be saved.'],
  ['transport', 'Employee details could not be saved.'],
  ['auth', 'Your session has expired. Sign in again.'],
  ['validation', 'Enter a valid work email.'],
]) test(`Directory ${outcome} rejection keeps the unsaved draft and exposes only safe accessible copy`, async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/?fixture=directory&outcome=${outcome}`);
  await page.getByLabel('Work email', { exact: true }).fill('edited@example.test');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(reason);
  await expect(page.getByLabel('Work email', { exact: true })).toHaveValue('edited@example.test');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText(/React.*441|private synthetic|private provider|Employee record saved/);
  expect(await page.evaluate(() => directoryRefreshes)).toBe(0);
  expect(await page.evaluate(() => directorySelections)).toEqual([]);
  expect(await page.evaluate(() => directoryCalls)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('Directory create rejection preserves the new employee draft without selecting or refreshing a saved record', async ({ page }) => {
  await page.goto('/?fixture=directory&outcome=create');
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  await page.getByLabel('First name', { exact: false }).fill('Synthetic');
  await page.getByLabel('Job title', { exact: false }).fill('Coordinator');
  await page.getByLabel('Team', { exact: false }).selectOption('Operation & Accounts');
  await page.getByLabel('Employment type', { exact: false }).selectOption('full_time');
  if (!await page.locator('input[name=startedDate]').isVisible()) await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('input[name=startedDate]').fill('2026-10-05');
  await page.getByLabel('Work email', { exact: true }).fill('new@example.test');
  await page.getByRole('button', { name: 'Create employee', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('onboarding credential delivery');
  await expect(page.getByLabel('Work email', { exact: true })).toHaveValue('new@example.test');
  await expect(page.getByRole('button', { name: 'Create employee', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => directoryRefreshes)).toBe(0);
  expect(await page.evaluate(() => directorySelections)).toEqual([null]);
  expect(await page.evaluate(() => directoryCalls.map(call => call.method))).toEqual(['create']);
});

for (const outcome of ['partialCreate', 'partialUpdate']) test(`Directory ${outcome} blocks a second mutation until refresh`, async ({ page }) => {
  await page.goto(`/?fixture=directory&outcome=${outcome}`);
  if (outcome === 'partialCreate') {
    await page.getByRole('button', { name: 'Add employee', exact: true }).click();
    await page.getByLabel('First name', { exact: false }).fill('Synthetic');
    await page.getByLabel('Job title', { exact: false }).fill('Coordinator');
    await page.getByLabel('Team', { exact: false }).selectOption('Operation & Accounts');
    await page.getByLabel('Employment type', { exact: false }).selectOption('full_time');
    if (!await page.locator('input[name=startedDate]').isVisible()) await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('input[name=startedDate]').fill('2026-10-05');
  }
  await page.getByLabel('Work email', { exact: true }).fill('new@example.test');
  const save = page.getByRole('button', { name: outcome === 'partialCreate' ? 'Create employee' : 'Save changes', exact: true });
  await save.click();
  await expect(page.getByRole('alert')).toContainText('were saved');
  await expect(save).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add employee', exact: true })).toBeDisabled();
  await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(await page.evaluate(() => directoryCalls.map(call => call.method))).toEqual([outcome === 'partialCreate' ? 'create' : 'update']);
  expect(await page.evaluate(() => directoryRefreshes)).toBe(0);
  await expect(page.getByLabel('Work email', { exact: true })).toHaveValue('new@example.test');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add employee', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => directoryCalls)).toEqual([]);
});

test('Directory role rejection keeps its selection without a saved-role notice', async ({ page }) => {
  await page.goto('/?fixture=directory');
  await page.getByRole('button', { name: 'Role', exact: true }).click();
  await page.getByLabel('Role', { exact: true }).selectOption('manager');
  await page.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Role has changed.');
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('manager');
  await expect(page.locator('body')).not.toContainText('Role saved.');
});

test('Directory committed role change blocks stale retries until refresh', async ({ page }) => {
  await page.goto('/?fixture=directory&outcome=partialRole');
  await page.getByRole('button', { name: 'Role', exact: true }).click();
  await page.getByLabel('Role', { exact: true }).selectOption('manager');
  await page.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Role was saved');
  await expect(page.getByRole('button', { name: 'Save role', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save role', exact: true }).evaluate(button => button.click());
  expect(await page.evaluate(() => directoryCalls.map(call => call.method))).toEqual(['role']);
  expect(await page.evaluate(() => directoryRefreshes)).toBe(0);
  await expect(page.locator('body')).not.toContainText('Role saved.');
});

for (const outcome of ['success', 'warning']) test(`Directory ${outcome} preserves committed-save workflow`, async ({ page }) => {
  await page.goto(`/?fixture=directory&outcome=${outcome}`);
  await page.getByLabel('Work email', { exact: true }).fill('edited@example.test');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => directoryRefreshes)).toBe(1);
  await expect(page.getByLabel('Work email', { exact: true })).toHaveValue('edited@example.test');
  if (outcome === 'warning') await expect(page.getByRole('alert')).toContainText('contract type was not');
  else await expect(page.locator('body')).toContainText('Employee record saved.');
});
