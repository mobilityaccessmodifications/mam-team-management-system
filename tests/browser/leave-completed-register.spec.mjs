import { test, expect } from '@playwright/test';

const names = { admin: 'Synthetic Admin', account: 'Synthetic Account', manager: 'Synthetic Manager', employee: 'Synthetic Employee' };
const ids = { admin: '11000000-0000-4000-8000-000000000002', account: '11000000-0000-4000-8000-000000000003', manager: '11000000-0000-4000-8000-000000000004', employee: '11000000-0000-4000-8000-000000000005' };
const group = page => page.getByRole('group', { name: 'Leave request status' });
const rows = page => page.getByRole('list', { name: 'Leave requests', exact: true }).getByRole('button');
const detail = page => page.locator('aside[aria-label$="leave details"], aside[role="dialog"]');
const tab = (page, label) => group(page).getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) });
const snapshot = (page, id) => page.evaluate(id => window.unifiedRoleFixture.leaveSnapshot(id), id);
const counts = page => group(page).getByRole('button').evaluateAll(buttons => Object.fromEntries(buttons.map(button => [button.childNodes[0].textContent, Number(button.querySelector('span').textContent)])));
const completed = data => data.requests.filter(request => request.status === 'Approved' && request.endDate < data.today);
const approved = data => data.requests.filter(request => request.status === 'Approved' && request.endDate >= data.today);
const errors = new WeakMap();

test.beforeEach(async ({ context, page, baseURL }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => /^(submit|decide|cancel|delete|update|stage|commit)/.test(call.name)))).toEqual([]);
});
async function open(page, suffix = '') {
  await page.goto(`/?fixture=unified-roles&leave-completed=1${suffix}`);
  await expect(group(page)).toBeVisible();
  await expect(tab(page, 'Completed')).toBeVisible();
}
async function selectProfile(page, role) {
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: new RegExp(names[role]) }).click();
  await expect(page.getByRole('dialog', { name: 'Change profile', exact: true })).toHaveCount(0);
  await page.getByRole('complementary', { name: 'People Hub navigation' }).getByRole('button', { name: /^Leave/ }).click();
  await expect(group(page)).toBeVisible();
}

for (const width of [390, 1440]) test(`completed register actual filter search sort page and selection at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await open(page);
  const data = await snapshot(page);
  const before = JSON.stringify(data);
  const originalCounts = await counts(page);
  expect(Object.keys(originalCounts)).toEqual(['All', 'Pending', 'Waiting for balance', 'Approved', 'Declined', 'Cancelled', 'Completed']);
  expect(originalCounts.All).toBe(data.requests.length);
  expect(originalCounts.Completed).toBe(completed(data).length);
  expect(originalCounts.Approved).toBe(approved(data).length);
  expect(Object.entries(originalCounts).filter(([label]) => label !== 'All').reduce((sum, [, count]) => sum + count, 0)).toBe(data.requests.length);
  await tab(page, 'Completed').click();
  await expect(tab(page, 'Completed')).toHaveAttribute('aria-pressed', 'true');
  await expect(tab(page, 'Approved')).toHaveAttribute('aria-pressed', 'false');
  await expect(rows(page)).toHaveCount(20);
  await rows(page).nth(1).click();
  await expect(detail(page)).toBeVisible();
  // A Completed category does not replace the original Approved status badge.
  await expect(rows(page).nth(1)).toContainText('Approved');
  if (width === 390) await page.getByRole('dialog').getByRole('button', { name: 'Close leave details', exact: true }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Leave request pagination' })).toContainText('Page 2 of');
  await page.getByRole('combobox', { name: 'Leave requests per page' }).selectOption('10');
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole('navigation', { name: 'Leave request pagination' })).toContainText('Page 1 of');
  await page.getByRole('combobox', { name: 'Sort leave requests' }).selectOption('oldest');
  await expect(rows(page).first()).toContainText('Sick leave');
  await page.getByRole('combobox', { name: 'Sort leave requests' }).selectOption('employee');
  await expect(rows(page).first()).toContainText('Synthetic Account');
  await page.getByRole('combobox', { name: 'Sort leave requests' }).selectOption('leaveType');
  await expect(rows(page).first()).toContainText('Annual leave');
  await page.getByRole('textbox', { name: 'Search leave requests' }).fill('Sick leave');
  await expect(rows(page)).toHaveCount(data.requests.filter(request => request.status === 'Approved' && request.endDate < data.today && request.leaveType === 'Sick leave').length);
  await expect(detail(page)).toHaveCount(0);
  await rows(page).first().click();
  await expect(detail(page)).toBeVisible();
  await expect(detail(page)).toContainText('Sick leave');
  if (width === 390) await page.getByRole('dialog').getByRole('button', { name: 'Close leave details', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search leave requests' }).fill('no synthetic match');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText('No matching requests', { exact: true })).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View more', exact: true })).toHaveCount(0);
  await tab(page, 'Approved').click();
  await expect(rows(page)).toHaveCount(approved(data).length);
  await expect(page.getByRole('textbox', { name: 'Search leave requests' })).toHaveValue('');
  for (const label of ['Pending', 'Waiting for balance', 'Declined', 'Cancelled']) {
    await tab(page, label).click();
    await expect(rows(page)).toHaveCount(originalCounts[label]);
    if (label === 'Cancelled' || label === 'Declined') await expect(page.getByRole('button', { name: 'View more', exact: true })).toHaveCount(0);
  }
  await tab(page, 'All').click();
  expect(await counts(page)).toEqual(originalCounts);
  expect(JSON.stringify(await snapshot(page))).toBe(before);
  // Existing responsive overflow stays inside the status group, not the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const role of ['system_admin', 'admin', 'account', 'manager', 'employee']) test(`completed register counts preserve ${role} role scope`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  if (role !== 'system_admin') await selectProfile(page, role);
  const data = await snapshot(page, ids[role]);
  const result = await counts(page);
  expect(result.All).toBe(data.requests.length);
  expect(result.Completed).toBe(completed(data).length);
  expect(result.Approved).toBe(approved(data).length);
  if (role === 'employee') expect(new Set(data.requests.map(request => request.personId))).toEqual(new Set([ids.employee]));
  if (role === 'manager') expect(new Set(data.requests.map(request => request.personId))).toEqual(new Set([ids.manager, ids.employee]));
  await tab(page, 'Completed').click();
  await expect(rows(page)).toHaveCount(Math.min(20, completed(data).length));
  await expect(page.getByRole('button', { name: 'View more', exact: true })).toHaveCount(0);
  expect(data.calendarEntries.filter(request => request.status === 'Approved').length).toBe(completed(data).length + approved(data).length);
  expect(data.calendarEntries.some(request => request.status === 'Completed')).toBe(false);
});

test('completed request deep link selects its exact record and page after mount', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, '&request=26000000-0000-4000-8000-000000000025');
  await expect(tab(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Leave request pagination' })).toContainText('Page 2 of');
  await expect(detail(page)).toContainText('Synthetic Admin');
  await expect(detail(page)).toContainText('Sick leave');
  await tab(page, 'Completed').click();
  await expect(detail(page)).toContainText('Annual leave');
  await expect(detail(page)).not.toContainText('Sick leave');
});

test('completed reclassification at Melbourne midnight uses the existing visible refresh interval', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date('2026-10-07T12:59:50Z') });
  await open(page);
  const data = await snapshot(page);
  await tab(page, 'Approved').click();
  const initial = await counts(page);
  const refreshBefore = await page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'loadEmployeeWorkScheduleWorkspace').length);
  await page.clock.fastForward(40_000);
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'loadEmployeeWorkScheduleWorkspace').length)).toBeGreaterThan(refreshBefore);
  const finishingToday = data.requests.filter(request => request.status === 'Approved' && request.endDate === data.today).length;
  await expect.poll(async () => (await counts(page)).Completed).toBe(initial.Completed + finishingToday);
  expect((await counts(page)).Approved).toBe(initial.Approved - finishingToday);
  expect((await counts(page)).All).toBe(initial.All);
  await expect(rows(page)).toHaveCount(initial.Approved - finishingToday);
  expect(JSON.stringify(await snapshot(page))).toBe(JSON.stringify(data));
});
