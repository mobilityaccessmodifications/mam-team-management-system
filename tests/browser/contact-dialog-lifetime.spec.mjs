import { test, expect } from '@playwright/test';

const id = '11000000-0000-4000-8000-000000000002';
const name = 'Synthetic Admin';
test.beforeEach(async ({ context, page, baseURL }) => {
  page.fixtureErrors = []; page.fixtureExternal = [];
  page.on('pageerror', error => page.fixtureErrors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    page.fixtureExternal.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?fixture=unified-roles');
});
test.afterEach(async ({ page }) => {
  expect(page.fixtureErrors).toEqual([]); expect(page.fixtureExternal).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
});

for (const outcome of ['success', 'rejection']) for (const close of ['Escape', 'button', 'backdrop']) test(`same profile ${close} close/reopen safely retires ${outcome}`, async ({ page }) => {
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
  const trigger = page.getByRole('button', { name: `Open ${name}'s profile`, exact: true });
  await expect(trigger).toBeEnabled(); await trigger.click();
  let dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog.getByLabel('Personal email')).toBeFocused();
  await dialog.getByLabel('Phone', { exact: true }).fill('old pending');
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('updateSelectedEmployeeProfile', id), id);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`updateSelectedEmployeeProfile:${id}`);
  if (close === 'Escape') await page.keyboard.press('Escape');
  else if (close === 'button') await dialog.getByRole('button', { name: 'Close profile', exact: true }).click();
  else await dialog.locator('..').click({ position: { x: 500, y: 900 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused(); await trigger.click();
  dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.getByLabel('Phone', { exact: true }).fill('new draft');
  const mutations = () => page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'updateSelectedEmployeeProfile').length);
  const submit = () => dialog.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await submit(); expect(await mutations()).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  const reads = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getLeaveWorkspaceData').length);
  await page.evaluate(({ id, outcome }) => outcome === 'success' ? window.unifiedRoleFixture.finish('updateSelectedEmployeeProfile', id) : window.unifiedRoleFixture.rejectPending('updateSelectedEmployeeProfile', id), { id, outcome });
  await expect(dialog.getByRole('button', { name: 'Refresh profile', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('new draft');
  await expect(dialog.locator('[data-tone]')).toHaveCount(0);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'getLeaveWorkspaceData').length)).toBe(reads);
  await submit(); expect(await mutations()).toBe(1);
  await dialog.getByRole('button', { name: 'Close profile', exact: true }).click(); await trigger.click();
  dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog.getByRole('button', { name: 'Refresh profile', exact: true })).toBeVisible();
  await submit(); expect(await mutations()).toBe(1);
  await Promise.all([page.waitForEvent('load'), dialog.getByRole('button', { name: 'Refresh profile', exact: true }).click()]);
  await page.waitForFunction(() => Boolean(window.unifiedRoleFixture));
  expect(await mutations()).toBe(0);
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
  await expect(trigger).toBeEnabled(); await trigger.click();
  dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.getByLabel('Phone', { exact: true }).fill('explicitly refreshed draft');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.locator('[data-tone="success"]')).toBeVisible();
  await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('explicitly refreshed draft');
  expect(await mutations()).toBe(1);
});
