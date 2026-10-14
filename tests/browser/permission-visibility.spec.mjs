import { test, expect } from '@playwright/test';

const peopleNavigation = page => page.getByRole('complementary', { name: 'People Hub navigation' });
const sections = page => page.getByRole('tablist', { name: 'People sections' });
const tasks = page => page.getByRole('region', { name: 'Tasks', exact: true });
const calls = (page, name) => page.evaluate(action => window.unifiedRoleFixture.calls.filter(call => call.name === action), name);
const checkInCalls = async page => (await calls(page, 'list_my_employee_check_in_tasks')).concat(await calls(page, 'list_employee_check_in_tasks_for_preview'));
const ownerId = '11000000-0000-4000-8000-000000000005';

async function openTasks(page) {
  await peopleNavigation(page).getByRole('button', { name: 'People', exact: true }).click();
  await sections(page).getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(tasks(page)).toBeVisible();
  await expect(tasks(page).getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled();
}

async function selectPreview(page, name) {
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
}

test.beforeEach(async ({ page, context, baseURL }) => {
  page.permissionErrors = [];
  page.on('pageerror', error => page.permissionErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test.afterEach(async ({ page }) => {
  expect(page.permissionErrors).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
});

for (const role of ['employee', 'account']) for (const width of [1440, 390]) {
  test(`permission visibility keeps ${role} schedule tasks without reviewer reads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/?fixture=unified-roles&tasks=combined&schedule-tasks&actor-role=${role}`);
    await openTasks(page);
    await expect(tasks(page).getByRole('button', { name: "Open Synthetic Employee's Work schedule change", exact: true })).toBeVisible();
    for (const type of ['check_in', 'subscription_review', 'subscription_password']) {
      await expect(tasks(page).locator(`option[value="${type}"]`)).toHaveCount(0);
    }
    for (const name of ['Accounts', 'Assets', 'Check-ins', 'Subscriptions', 'Analytics API']) {
      await expect(sections(page).getByRole('tab', { name, exact: true })).toHaveCount(0);
    }
    await expect(tasks(page).getByRole('alert')).toHaveCount(0);
    expect(await checkInCalls(page)).toEqual([]);
    expect(await calls(page, 'list_my_subscription_review_tasks')).toEqual([]);
    expect(await calls(page, 'list_my_subscription_password_tasks')).toEqual([]);
    expect(await calls(page, 'listPortalAccounts')).toEqual([]);
    await tasks(page).getByRole('button', { name: 'Refresh tasks', exact: true }).click();
    await expect(tasks(page).getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled();
    expect(await checkInCalls(page)).toEqual([]);
    await expect(tasks(page)).not.toContainText('permission');
  });
}

for (const role of ['manager', 'admin']) {
  test(`permission visibility retains authorized ${role} check-in tasks`, async ({ page }) => {
    await page.goto(`/?fixture=unified-roles&tasks=combined&actor-role=${role}`);
    await openTasks(page);
    await expect(tasks(page).getByRole('button', { name: "Open Synthetic Check-in Employee's 1-month check-in", exact: true })).toBeVisible();
    await expect(tasks(page).locator('option[value="check_in"]')).toHaveCount(1);
    expect(await calls(page, 'list_my_employee_check_in_tasks')).toHaveLength(1);
    await expect(tasks(page).getByRole('alert')).toHaveCount(0);
  });
}

test('permission visibility keeps delegated Employee subscription tasks independently of check-ins', async ({ page }) => {
  await page.goto('/?fixture=unified-roles&tasks=combined&subscription-reviews=register-manager&subscription-passwords');
  await openTasks(page);
  await expect(tasks(page).getByRole('button', { name: "Open Synthetic due review's Quarterly subscription review", exact: true })).toBeVisible();
  await expect(tasks(page).getByRole('button', { name: "Open Synthetic password service's Change subscription account password", exact: true })).toBeVisible();
  await expect(tasks(page).locator('option[value="check_in"]')).toHaveCount(0);
  expect(await checkInCalls(page)).toEqual([]);
  expect(await calls(page, 'list_my_subscription_review_tasks')).toHaveLength(1);
  expect(await calls(page, 'list_my_subscription_password_tasks')).toHaveLength(1);
});

for (const name of ['Synthetic Employee', 'Synthetic Account', 'Synthetic Manager']) {
  test(`permission visibility avoids Accounts prefetch for ${name} preview`, async ({ page }) => {
    await page.goto('/?fixture=unified-roles&tasks=combined');
    await expect.poll(() => calls(page, 'listPortalAccounts')).toHaveLength(1);
    await selectPreview(page, name);
    await openTasks(page);
    expect(await calls(page, 'listPortalAccounts')).toHaveLength(1);
    await expect(sections(page).getByRole('tab', { name: 'Accounts', exact: true })).toHaveCount(0);
    if (name !== 'Synthetic Manager') {
      expect(await checkInCalls(page)).toEqual([]);
      await expect(tasks(page).locator('option[value="check_in"]')).toHaveCount(0);
    }
  });
}

test('permission visibility waits for preview capabilities before dispatching protected reads', async ({ page }) => {
  await page.goto('/?fixture=unified-roles&tasks=combined');
  await expect.poll(() => calls(page, 'listPortalAccounts')).toHaveLength(1);
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('getPortalRoleCapabilities', id), ownerId);
  await selectPreview(page, 'Synthetic Employee');
  await expect(page.getByText('Loading role permissions…', { exact: true })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'People sections' })).toHaveCount(0);
  expect(await calls(page, 'listPortalAccounts')).toHaveLength(1);
  expect(await checkInCalls(page)).toEqual([]);
  await page.evaluate(id => window.unifiedRoleFixture.finish('getPortalRoleCapabilities', id), ownerId);
  await openTasks(page);
  expect(await checkInCalls(page)).toEqual([]);
  expect(await calls(page, 'listPortalAccounts')).toHaveLength(1);
});

test('permission visibility preserves a genuine authorized check-in load failure', async ({ page }) => {
  await page.goto('/?fixture=unified-roles&tasks=combined&actor-role=manager&check-in-error');
  await openTasks(page);
  await expect(tasks(page).getByRole('alert')).toContainText('Check-in tasks could not be loaded. Refresh and try again.');
  await expect(tasks(page)).not.toContainText('synthetic private provider detail');
  await expect(tasks(page).locator('option[value="check_in"]')).toHaveCount(1);
  await tasks(page).getByRole('button', { name: 'Refresh tasks', exact: true }).click();
  await expect.poll(() => calls(page, 'list_my_employee_check_in_tasks')).toHaveLength(2);
  await expect(tasks(page).getByRole('alert')).toBeVisible();
});
