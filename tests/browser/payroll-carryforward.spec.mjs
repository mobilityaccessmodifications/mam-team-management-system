import { test, expect } from '@playwright/test';
test('payroll retained commitments remain separate from the banked estimate and enter request availability', async ({ page }) => {
  await page.goto('/?fixture=payroll-carryforward');
  const balances = page.getByRole('region', { name: 'Employee leave balances' });
  await expect(balances).toContainText('Owner-approved estimate');
  await expect(balances).toContainText('Banked balance140.43 hours');
  await expect(balances).toContainText('Approved leave after balance date-7.6 hours');
  await expect(balances).toContainText('Retained unsettled commitment-38 hours');
  await expect(balances).toContainText('Available after approved leave94.83 hours');
  await expect(page.getByText('Current Xero balance')).toHaveCount(0);
  await expect(page.getByText('Sick leave', { exact: true })).toHaveCount(0);
  await page.getByText('Annual leave balance:').click();
  await expect(page.getByText('Remaining after this request').locator('..')).toContainText('87.23 hours');
  await expect(page.getByText('Other confirmed leave taken', { exact: true })).toHaveCount(0);
});
