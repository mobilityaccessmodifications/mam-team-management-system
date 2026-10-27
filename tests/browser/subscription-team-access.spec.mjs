import { test, expect } from '@playwright/test';

const subscriptionId = '33000000-0000-4000-8000-000000000001';
const employeeId = '11000000-0000-4000-8000-000000000005';
const mamAlexId = '11000000-0000-4000-8000-000000000010';
const equipsyAlexId = '11000000-0000-4000-8000-000000000011';
const triggerFor = page => page.getByRole('button', { name: 'Manage team access for Synthetic service', exact: true });
const dialogFor = page => page.getByRole('dialog', { name: 'Team access', exact: true });
const checkboxFor = (dialog, id) => dialog.locator(`input[type=checkbox][id$="${id}"]`);
const writes = page => page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => call.name === 'updateSubscriptionTeamAccess'));

async function openRegister(page, query = '') {
  await page.goto(`/?fixture=unified-roles&subscription-team-access${query}`);
  await page.getByRole('complementary', { name: 'People Hub navigation' }).getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('tablist', { name: 'People sections' }).getByRole('tab', { name: 'Subscriptions', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Subscriptions', exact: true })).toBeVisible();
}

test.beforeEach(async ({ page, context, baseURL }) => {
  page.teamErrors = [];
  page.teamExternal = [];
  page.on('pageerror', error => page.teamErrors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    page.teamExternal.push(route.request().url());
    return route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(page.teamErrors).toEqual([]);
  expect(page.teamExternal).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture?.unexpected ?? [])).toEqual([]);
});

for (const width of [1440, 390]) test(`subscription team access aligns people and saves exact identities at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await openRegister(page);
  const trigger = triggerFor(page);
  await expect(trigger).toContainText('Synthetic Employee');
  await trigger.click();
  const dialog = dialogFor(page);
  await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  await expect(dialog.getByRole('button', { name: 'Save team access' })).toBeDisabled();
  const layout = await dialog.locator('label:has(input[type=checkbox])').evaluateAll(labels => labels.map(label => {
    const box = label.querySelector('input').getBoundingClientRect();
    const text = label.querySelector('strong').getBoundingClientRect();
    const row = label.getBoundingClientRect();
    return { width: box.width, height: box.height, aligned: box.right <= text.left && box.top >= row.top && box.bottom <= row.bottom, labelFor: label.htmlFor === label.querySelector('input').id };
  }));
  expect(layout.length).toBe(6);
  expect(layout.filter(row => row.width !== 20 || row.height !== 20 || !row.aligned || !row.labelFor)).toEqual([]);
  const search = dialog.getByRole('searchbox', { name: 'Search team members' });
  await search.fill('Alex');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await checkboxFor(dialog, mamAlexId).locator('..').getByText('Alex Synthetic', { exact: true }).click();
  await expect(checkboxFor(dialog, mamAlexId)).toBeChecked();
  await expect(checkboxFor(dialog, equipsyAlexId)).not.toBeChecked();
  await dialog.getByRole('combobox', { name: 'Filter team members by company' }).selectOption('equipsy');
  await dialog.getByRole('combobox', { name: 'Filter team members by team' }).selectOption('Operations');
  await checkboxFor(dialog, equipsyAlexId).check();
  await expect(dialog.getByRole('button', { name: 'Remove Alex Synthetic, Marketing, MAM', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove Synthetic Employee, Operation & Accounts, MAM', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save team access', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await writes(page))[0].args).toEqual([{ subscriptionId, version: 1, memberPersonIds: [employeeId, mamAlexId, equipsyAlexId] }]);
  await expect(trigger).toContainText('3 assigned');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(checkboxFor(dialogFor(page), mamAlexId)).toBeChecked();
  await expect(checkboxFor(dialogFor(page), equipsyAlexId)).toBeChecked();
  await expect(checkboxFor(dialogFor(page), employeeId)).toBeChecked();
  await dialogFor(page).getByRole('button', { name: /^Remove / }).evaluateAll(buttons => buttons.forEach(button => button.click()));
  await expect(dialogFor(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  await dialogFor(page).getByRole('button', { name: 'Save team access', exact: true }).click();
  await expect(trigger).toContainText('0 assigned');
  expect((await writes(page))[1].args).toEqual([{ subscriptionId, version: 2, memberPersonIds: [] }]);
  if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('subscription team access locks pending saves and reconciles a lost committed response without retrying', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openRegister(page);
  await triggerFor(page).click();
  const dialog = dialogFor(page);
  await checkboxFor(dialog, mamAlexId).check();
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('updateSubscriptionTeamAccess', id), subscriptionId);
  await dialog.getByRole('button', { name: 'Save team access', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`updateSubscriptionTeamAccess:${subscriptionId}`);
  expect(await dialog.locator('input,select,button').evaluateAll(nodes => nodes.every(node => node.matches(':disabled')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(await writes(page)).toHaveLength(1);
  await page.evaluate(id => window.unifiedRoleFixture.rejectPending('updateSubscriptionTeamAccess', id), subscriptionId);
  await expect(dialog.getByRole('alert')).toContainText('could not be confirmed');
  await expect(dialog.getByRole('button', { name: 'Save team access', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reload access', exact: true }).click();
  await expect(checkboxFor(dialog, mamAlexId)).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save team access', exact: true })).toBeDisabled();
  expect(await writes(page)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(triggerFor(page)).toContainText('2 assigned');
  await triggerFor(page).click();
  await expect(checkboxFor(dialogFor(page), mamAlexId)).toBeChecked();
  await expect(dialogFor(page).getByRole('button', { name: 'Save team access', exact: true })).toBeDisabled();
});

test('subscription team access reloads conflicting assignments before another explicit save', async ({ page }) => {
  await openRegister(page);
  await triggerFor(page).click();
  const dialog = dialogFor(page);
  await checkboxFor(dialog, mamAlexId).check();
  await page.evaluate(id => window.unifiedRoleFixture.failNext('updateSubscriptionTeamAccess', id, 'stale'), subscriptionId);
  await dialog.getByRole('button', { name: 'Save team access', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('has changed');
  await expect(checkboxFor(dialog, mamAlexId)).toBeDisabled();
  await dialog.getByRole('button', { name: 'Reload access', exact: true }).click();
  await expect(checkboxFor(dialog, employeeId)).not.toBeChecked();
  await expect(checkboxFor(dialog, mamAlexId)).not.toBeChecked();
  await checkboxFor(dialog, equipsyAlexId).check();
  await dialog.getByRole('button', { name: 'Save team access', exact: true }).click();
  expect((await writes(page))[1].args).toEqual([{ subscriptionId, version: 2, memberPersonIds: ['11000000-0000-4000-8000-000000000002', equipsyAlexId] }]);
});

test('subscription team access keeps the shared edit picker aligned and managers read only', async ({ page }) => {
  await openRegister(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit subscription', exact: true });
  await editor.locator('summary').filter({ hasText: /^Team access/ }).click();
  await checkboxFor(editor, equipsyAlexId).check();
  await expect(checkboxFor(editor, equipsyAlexId)).toBeChecked();
  const shape = await checkboxFor(editor, equipsyAlexId).evaluate(input => ({ width: input.getBoundingClientRect().width, labelDisplay: getComputedStyle(input.parentElement).display }));
  expect(shape).toEqual({ width: 20, labelDisplay: 'grid' });
  await page.keyboard.press('Escape');
  await openRegister(page, '&actor-role=manager');
  await expect(triggerFor(page)).toHaveCount(0);
  await expect(page.getByRole('cell').filter({ hasText: '1 assigned' })).toContainText('Synthetic Employee');
  expect(await writes(page)).toHaveLength(0);
});
