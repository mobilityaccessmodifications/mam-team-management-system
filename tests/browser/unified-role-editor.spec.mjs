import { test, expect } from '@playwright/test';

const cards = {
  employee: {
    can: /Use own profile, leave, availability calendar, resources and work-schedule requests; view the safe team directory/,
    cannot: /Approve leave, edit staff or accounts, manage payroll balances, manage subscriptions or access credentials without delegation, or administer the system/,
    scope: /Own records and the privacy-preserving team view/,
    delegation: /Subscription register management and credential-vault access are separate optional switches controlled by Super Admin. Neither grant implies the other/,
  },
  manager: {
    can: /Review reporting-team leave and work-schedule requests, submit leave on behalf of eligible reports, review check-ins and edit manager-safe directory fields/,
    cannot: /Approve own leave, edit private HR fields or portal accounts, commit payroll balances, change roles or system settings/,
    scope: /Current reporting tree and existing company\/record rules; no self-approval/,
    delegation: /Subscription register management and credential-vault access are separate optional switches controlled by Super Admin. Neither grant implies the other/,
  },
  account: {
    can: /Read the all-status leave register, existing notes and existing evidence/,
    cannot: /Decide or cancel another person's leave, upload\/delete their evidence, submit leave on behalf, edit staff\/accounts/,
    scope: /Read-only staff leave across both supported companies; retained uploads and immutable comparisons stay uploader-scoped/,
  },
  admin: {
    can: /Administer Directory\/CSV, Organisation, portal account provisioning\/reset\/status\/login, devices, subscription register and credentials, global leave review, manual balances\/accrual, check-ins, employment decisions and work schedules/,
    cannot: /Approve own leave, assign roles, use Change profile, configure analytics\/security or subscription delegates, or purge confirmed test identities/,
    scope: /All-module daily operations, preserving existing record, company, audit and anti-self rules. P0 controls remain exclusive to Super Admin/,
  },
};

test.beforeEach(async ({ context, page, baseURL }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.__unifiedRoleErrors = errors;
});
test.afterEach(async ({ page }) => expect(page.__unifiedRoleErrors).toEqual([]));

for (const [role, card] of Object.entries(cards)) test(`P0 Role editor renders the actual ${role} permission card and exactly four non-P0 options`, async ({ page }) => {
  await page.goto('/?fixture=directory');
  await page.getByRole('button', { name: 'Role', exact: true }).click();
  const picker = page.getByLabel('Role', { exact: true });
  await expect(picker).toBeEnabled();
  expect(await picker.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent })))).toEqual([
    { value: 'employee', label: 'Team member' }, { value: 'manager', label: 'Manager' },
    { value: 'account', label: 'Account' }, { value: 'admin', label: 'Admin' },
  ]);
  await picker.selectOption(role);
  const impact = page.getByRole('status').filter({ hasText: 'Role impact' });
  await expect(impact).toContainText(card.can);
  await expect(impact).toContainText(card.cannot);
  await expect(impact).toContainText(card.scope);
  await expect(impact.getByText('Can', { exact: true })).toBeVisible();
  await expect(impact.getByText('Cannot', { exact: true })).toBeVisible();
  await expect(impact.getByText('Scope', { exact: true })).toBeVisible();
  if (card.delegation) await expect(impact).toContainText(card.delegation);
  if (role === 'account') {
    await expect(impact).toContainText('upload payroll files for comparison-only results');
    await expect(impact).toContainText('access the credential vault or commit balances, edit balances/accrual or change system settings');
  }
  const save = page.getByRole('button', { name: 'Save role', exact: true });
  if (role === 'employee') await expect(save).toBeDisabled();
  else await expect(save).toBeEnabled();
  expect(await page.evaluate(() => directoryCalls)).toEqual([]);
});

test('ordinary Admin directory never renders or loads P0 role controls', async ({ page }) => {
  await page.goto('/?fixture=directory&viewer=admin');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Role', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Role', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => directoryRoleReads)).toBe(0);
});

test('a stored P0 account cannot be edited by the ordinary Role editor', async ({ page }) => {
  await page.goto('/?fixture=directory&storedRole=system_admin');
  await expect.poll(() => page.evaluate(() => directoryRoleReads)).toBe(1);
  await expect(page.getByRole('button', { name: 'Role', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Role', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => directoryCalls)).toEqual([]);
});

for (const role of Object.keys(cards)) test(`P0 Role editor saves ${role} with the current expected role and invalidates once`, async ({ page }) => {
  const expectedRole = role === 'employee' ? 'manager' : 'employee';
  await page.goto(`/?fixture=directory&outcome=roleSuccess&storedRole=${expectedRole}`);
  await page.getByRole('button', { name: 'Role', exact: true }).click();
  await page.getByLabel('Role', { exact: true }).selectOption(role);
  await page.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Role saved.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save role', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => directoryCalls)).toEqual([{ method: 'role', input: {
    personId: '10000000-0000-4000-8000-000000000001', role, expectedRole,
  } }]);
  expect(await page.evaluate(() => directoryRefreshes)).toBe(1);
});
