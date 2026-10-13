import { test, expect } from '@playwright/test';

for (const [scenario, message] of [
  ['protected', "Reporting links are protected while onboarding credential delivery is in progress or awaiting administrator review."],
  ['readError', "The employee's reporting links could not be checked. Refresh and try again."],
]) test(`End employment ${scenario} rejection shows the real safe action result and retains the dialog`, async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/?fixture=directory&archivePreflight=${scenario}`);
  await page.getByRole('button', { name: 'End employment', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'End employment' });
  await dialog.getByLabel('Employment end date').fill('2026-10-09');
  await dialog.getByLabel('Reason for leaving').selectOption('Other');
  await dialog.getByRole('button', { name: 'Confirm end date' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(message);
  await expect(dialog.getByLabel('Employment end date')).toHaveValue('2026-10-09');
  await expect(dialog.getByLabel('Reason for leaving')).toHaveValue('Other');
  await expect(dialog.getByRole('button', { name: 'Confirm end date' })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText(/private synthetic|React.*441|Employment ended, portal account disabled/);
  expect(await page.evaluate(() => directoryRefreshes)).toBe(0);
  expect(await page.evaluate(() => directoryCalls)).toEqual([{
    method: 'archive', input: {
      personId: '10000000-0000-4000-8000-000000000001',
      personVersion: 1, detailVersion: 1, endDate: '2026-10-09', reason: 'Other',
    },
  }]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => directoryCalls)).toHaveLength(1);
  expect(errors).toEqual([]);
});
