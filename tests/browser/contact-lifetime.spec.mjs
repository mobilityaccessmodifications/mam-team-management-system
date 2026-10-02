import { test, expect } from '@playwright/test';
test.skip(!process.env.MAM_CONTACT_ORIGIN, 'Dedicated real contact-component bundle required');
const id = '11000000-0000-4000-8000-000000000002';
const secondId = '11000000-0000-4000-8000-000000000003';
const observations = new WeakMap();
const mutationCount = page => page.evaluate(() => window.contactFixture.calls.filter(c => c.name.startsWith('update') && c.name.endsWith('Profile')).length);
async function open(page, name = 'Synthetic A') {
  const trigger = page.getByRole('button', { name: `Open ${name}'s profile`, exact: true });
  await expect(trigger).toBeEnabled(); await trigger.click();
  return page.getByRole('dialog', { name, exact: true });
}
async function pick(page, name) {
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
}
async function close(page, dialog, kind) {
  if (kind === 'escape') await page.keyboard.press('Escape');
  else if (kind === 'button') await dialog.getByRole('button', { name: 'Close profile', exact: true }).click();
  else await dialog.locator('..').click({ position: { x: 500, y: 900 } });
  await expect(dialog).toBeHidden();
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const observed = { errors: [], external: [] }; observations.set(page, observed);
  page.on('pageerror', error => observed.errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === process.env.MAM_CONTACT_ORIGIN) return route.continue();
    observed.external.push(route.request().url()); return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(observations.get(page)).toEqual({ errors: [], external: [] });
});
for (const reject of [false, true]) for (const kind of ['escape', 'button', 'backdrop']) test(`real LeaveDemo same-selection retired ${kind} reject=${reject}`, async ({ page }) => {
  await page.goto('/'); await pick(page, 'Synthetic A'); let dialog = await open(page);
  await dialog.getByLabel('Phone', { exact: true }).fill('old pending'); await page.evaluate(id => window.contactFixture.hold(id), id);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.waitForFunction(id => window.contactFixture.pendingKeys().includes(id), id);
  await close(page, dialog, kind); dialog = await open(page); await dialog.getByLabel('Phone', { exact: true }).fill('new draft');
  await dialog.locator('form').evaluate(f => f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(await mutationCount(page)).toBe(1); await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  const refreshes = await page.evaluate(() => window.contactFixture.calls.filter(c => c.name === 'getLeaveWorkspaceData').length);
  await page.evaluate(({ id, reject }) => window.contactFixture.finish(id, reject), { id, reject });
  await expect(dialog.getByRole('button', { name: 'Refresh profile', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('new draft'); await expect(dialog.locator('[data-tone]')).toHaveCount(0);
  expect(await page.evaluate(() => window.contactFixture.calls.filter(c => c.name === 'getLeaveWorkspaceData').length)).toBe(refreshes);
  await dialog.locator('form').evaluate(f => f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); expect(await mutationCount(page)).toBe(1);
  await close(page, dialog, 'button'); dialog = await open(page); await expect(dialog.getByRole('button', { name: 'Refresh profile', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Refresh profile', exact: true }).click(); await page.waitForFunction(() => window.contactFixture && window.contactFixture.calls.every(c => !c.name.startsWith('update')));
  await pick(page, 'Synthetic A'); dialog = await open(page); await dialog.getByLabel('Phone', { exact: true }).fill('post refresh'); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.locator('[data-tone="success"]')).toBeVisible(); expect(await mutationCount(page)).toBe(1);
  expect(await page.evaluate(() => window.contactFixture.unexpected)).toEqual([]);
});
for (const reject of [false, true]) for (const identical of [false, true]) for (const returnToA of [false, true]) for (const newer of [false, true]) test(`real LeaveDemo cross-selection reject=${reject} identical=${identical} ABA=${returnToA} newer=${newer}`, async ({ page }) => {
  await page.goto('/'); if (identical) await page.evaluate(({ id, secondId }) => window.contactFixture.identical(secondId, id), { id, secondId });
  await pick(page, 'Synthetic A'); let dialog = await open(page); await dialog.getByLabel('Phone', { exact: true }).fill('old pending'); await page.evaluate(id => window.contactFixture.hold(id), id); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.waitForFunction(id => window.contactFixture.pendingKeys().includes(id), id);
  await close(page, dialog, 'escape'); await pick(page, 'Synthetic B'); if (returnToA) await pick(page, 'Synthetic A');
  const targetId = returnToA ? id : secondId; dialog = await open(page, returnToA || identical ? 'Synthetic A' : 'Synthetic B'); await dialog.getByLabel('Phone', { exact: true }).fill('new draft');
  if (newer) { await page.evaluate(id => window.contactFixture.hold(id), targetId); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeVisible(); }
  const before = await page.evaluate(() => window.contactFixture.calls.filter(c => c.name === 'getLeaveWorkspaceData').length);
  await page.evaluate(({ id, reject }) => window.contactFixture.finish(id, reject), { id, reject }); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('new draft'); await expect(dialog.locator('[data-tone]')).toHaveCount(0);
  const saveButton = dialog.getByRole('button', { name: newer ? 'Saving…' : 'Save changes', exact: true });
  if (newer) await expect(saveButton).toBeDisabled(); else await expect(saveButton).toBeEnabled();
  expect(await page.evaluate(() => window.contactFixture.calls.filter(c => c.name === 'getLeaveWorkspaceData').length)).toBe(before);
  if (newer) { await page.evaluate(id => window.contactFixture.finish(id), targetId); await expect(dialog.locator('[data-tone="success"]')).toBeVisible(); }
  expect(await page.evaluate(() => window.contactFixture.unexpected)).toEqual([]);
});
test('native focus, successful DTO replacement, saved reopen', async ({ page }) => {
  await page.goto('/?native'); let dialog = await open(page); await expect(dialog.locator('input[type="email"]:not([readonly])')).toBeFocused();
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true); }
  await dialog.getByLabel('Phone', { exact: true }).fill('saved phone'); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog.locator('[data-tone="success"]')).toBeVisible(); await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('saved phone');
  await close(page, dialog, 'escape'); await expect(page.getByRole('button', { name: "Open Synthetic A's profile", exact: true })).toBeFocused(); dialog = await open(page); await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('saved phone');
  await close(page, dialog, 'button'); await expect(page.getByRole('button', { name: "Open Synthetic A's profile", exact: true })).toBeFocused();
});
test('late DTO cannot erase reopened draft', async ({ page }) => {
  await page.goto('/?native'); let dialog = await open(page); await dialog.getByLabel('Phone', { exact: true }).fill('pending'); await page.evaluate(id => window.contactFixture.hold(id), id); await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.waitForFunction(id => window.contactFixture.pendingKeys().includes(id), id);
  await close(page, dialog, 'escape'); dialog = await open(page); await dialog.getByLabel('Phone', { exact: true }).fill('reopened'); await page.evaluate(() => window.contactFixture.replaceDTO()); await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('reopened');
  await page.evaluate(id => window.contactFixture.finish(id), id); await expect(dialog.getByRole('button', { name: 'Refresh profile', exact: true })).toBeVisible(); await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('reopened');
});
