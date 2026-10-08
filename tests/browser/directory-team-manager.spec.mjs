import { test, expect } from '@playwright/test';

async function closeMobileEditor(page) {
  if (page.viewportSize().width > 900) return;
  const dialog = page.getByRole('dialog', { name: 'Edit employee', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close employee record', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function openCreate(page, query = '') {
  await page.goto(`/?fixture=directory&teamManager=valid&outcome=success${query}`);
  await closeMobileEditor(page);
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  await page.getByLabel('First name', { exact: false }).fill('Synthetic new starter');
  await page.getByLabel('Job title', { exact: false }).fill('Coordinator');
  await page.getByLabel('Team', { exact: false }).selectOption('Warehouse');
  await page.getByLabel('Employment type', { exact: false }).selectOption('full_time');
  await page.locator('input[name=startedDate]').fill('2026-10-08');
}
for (const width of [390, 1280]) test(`Team Manager ${width}px default display and explicit override stay creation-only`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await openCreate(page);
  const manager = page.getByLabel('Reports to', { exact: true });
  await expect(manager.locator('option:checked')).toHaveText('Team Manager: Morgan Synthetic');
  await expect(manager).toHaveValue('');
  await page.getByRole('button', { name: 'Create employee', exact: true }).click();
  await expect.poll(() => page.evaluate(() => directoryCalls.filter(call => call.method === 'create').length)).toBe(1);
  expect(await page.evaluate(() => directoryCalls[0].input.managerId)).toBeNull();
  await expect(manager).toHaveCount(0);
  await closeMobileEditor(page);
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  await page.getByLabel('First name', { exact: false }).fill('Synthetic override');
  await page.getByLabel('Job title', { exact: false }).fill('Coordinator');
  await page.getByLabel('Team', { exact: false }).selectOption('Warehouse');
  await page.getByLabel('Employment type', { exact: false }).selectOption('full_time');
  await page.locator('input[name=startedDate]').fill('2026-10-08');
  await manager.selectOption('10000000-0000-4000-8000-000000000004');
  await page.getByRole('button', { name: 'Create employee', exact: true }).click();
  await expect.poll(() => page.evaluate(() => directoryCalls.filter(call => call.method === 'create').length)).toBe(2);
  expect(await page.evaluate(() => directoryCalls.at(-1).input.managerId)).toBe('10000000-0000-4000-8000-000000000004');
});
test('Team Manager missing configuration is visible and permits an unassigned save', async ({ page }) => {
  await openCreate(page, '&managerState=missing');
  await expect(page.getByLabel('Reports to').locator('option:checked')).toHaveText('No Team Manager — saved unassigned');
  await page.getByRole('button', { name: 'Create employee', exact: true }).click();
  await expect.poll(() => page.evaluate(() => directoryCalls.length)).toBe(1);
  expect(await page.evaluate(() => directoryCalls[0].input.managerId)).toBeNull();
});
test('Team Manager invalid configuration blocks create until an explicit valid manager is selected', async ({ page }) => {
  await openCreate(page, '&managerState=invalid');
  await expect(page.getByRole('alert')).toContainText('Choose a valid manager');
  await expect(page.getByRole('button', { name: 'Create employee', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => directoryCalls)).toEqual([]);
  await page.getByLabel('Reports to').selectOption('10000000-0000-4000-8000-000000000004');
  await page.getByRole('button', { name: 'Create employee', exact: true }).click();
  await expect.poll(() => page.evaluate(() => directoryCalls.length)).toBe(1);
});
test('Team Manager company switch fences a delayed response and clears the old explicit selection', async ({ page }) => {
  await openCreate(page, '&managerState=held');
  await page.getByLabel('Reports to').selectOption('10000000-0000-4000-8000-000000000004');
  await page.locator('form').getByLabel('Company', { exact: false }).selectOption('equipsy');
  await page.getByLabel('Team', { exact: false }).selectOption('Equipsy');
  await expect(page.getByLabel('Reports to').locator('option:checked')).toHaveText('Team Manager: Casey Synthetic');
  await page.evaluate(() => window.releaseOldTeamManager());
  await expect(page.getByLabel('Reports to').locator('option:checked')).toHaveText('Team Manager: Casey Synthetic');
  await expect(page.getByLabel('Reports to')).toHaveValue('');
  await expect(page.getByLabel('Reports to').locator('option')).not.toContainText(['Morgan Synthetic', 'Riley Synthetic']);
  await page.getByRole('button', { name: 'Create employee', exact: true }).click();
  await expect.poll(() => page.evaluate(() => directoryCalls.length)).toBe(1);
  expect(await page.evaluate(() => ({ company: directoryCalls[0].input.company, team: directoryCalls[0].input.teamName, parent: directoryCalls[0].input.managerId })))
    .toEqual({ company: 'equipsy', team: 'Equipsy', parent: null });
});
