import { test, expect } from '@playwright/test';
import { syntheticRolePeople, syntheticPerformanceManager } from './unified-role-data.mjs';

const people = Object.fromEntries(syntheticRolePeople.map(person => [person.role, person]));
people.managerB = syntheticPerformanceManager;
const navigation = page => page.getByRole('complementary', { name: 'People Hub navigation' });
const preview = page => page.getByRole('region', { name: 'Employee access preview' });
const workspace = page => page.getByRole('region', { name: 'Performance reviews', exact: true });
const calls = (page, name) => page.evaluate(name => window.unifiedRoleFixture.calls.filter(call => call.name === name), name);
const writes = page => page.evaluate(() => window.unifiedRoleFixture.calls.filter(call => ['startPerformanceReview', 'mutatePerformanceReview', 'reconcilePerformanceReviewOperation'].includes(call.name)));

async function selectProfile(page, key) {
  await preview(page).locator('button[aria-haspopup="dialog"]').click();
  const dialog = page.getByRole('dialog', { name: 'Change profile', exact: true });
  await dialog.getByRole('button').filter({ has: page.getByText(people[key].name, { exact: true }) }).click();
  await expect(dialog).toHaveCount(0);
  await expect(preview(page)).toContainText(`Viewing ${people[key].name}`);
}
async function openPerformance(page) {
  await navigation(page).getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('tablist', { name: 'People sections' }).getByRole('tab', { name: 'Performance reviews', exact: true }).click();
  await expect(workspace(page)).toBeVisible();
}
async function assertReadOnly(page) {
  const panel = workspace(page);
  await expect(panel.locator('[name="self-0"]')).toBeVisible();
  const fields = panel.locator('input, textarea, select');
  expect(await fields.count()).toBeGreaterThan(0);
  for (const field of await fields.all()) await expect(field).toBeDisabled();
  for (const button of await panel.getByRole('button', { name: /^(?:New yearly review|Save self draft|Submit self assessment|Save manager draft|Complete manager assessment|Save meeting|Finalise review|Reconcile update)$/ }).all()) await expect(button).toBeDisabled();
  for (const form of await panel.locator('form').all()) await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(panel.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  expect(await writes(page)).toEqual([]);
}

test.beforeEach(async ({ page, context, baseURL }) => {
  page.__performanceErrors = []; page.__performanceExternal = [];
  page.on('pageerror', error => page.__performanceErrors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    page.__performanceExternal.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?fixture=unified-roles&performance-preview');
});
test.afterEach(async ({ page }) => {
  expect(page.__performanceErrors).toEqual([]);
  expect(page.__performanceExternal).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
});

test('actual LeaveDemo Performance preview switches P0 through distinct manager employee account admin scopes with no writes', async ({ page }) => {
  await openPerformance(page);
  await expect(workspace(page).getByRole('heading', { name: 'Synthetic P0 scope — MAM', exact: true })).toBeVisible();
  for (const [key, name] of [['manager', 'Synthetic A report'], ['employee', 'Synthetic Employee'], ['account', 'Synthetic Account'], ['admin', 'Synthetic HR scope'], ['managerB', 'Synthetic B report']]) {
    await selectProfile(page, key); await openPerformance(page);
    const panel = workspace(page);
    await expect(panel.getByRole('heading', { name: `${name} — MAM`, exact: true })).toBeVisible();
    await assertReadOnly(page);
    expect((await calls(page, 'loadPerformanceReviews')).at(-1).args).toEqual([people[key].id]);
    const rowButtons = panel.getByRole('navigation', { name: 'Review list' }).getByRole('button');
    await expect(rowButtons).toHaveCount(key.startsWith('manager') ? 2 : 1);
    if (key.startsWith('manager')) {
      await expect(panel.getByRole('button', { name: 'New yearly review', exact: true })).toBeDisabled();
      await expect(panel.locator('[name="held"]')).toBeDisabled();
      await rowButtons.filter({ hasText: people[key].name }).click();
      await expect(panel.locator('[name="self-0"]')).toHaveValue(`${people[key].name} answer 1`);
      await assertReadOnly(page);
      await rowButtons.filter({ hasText: name }).click();
    } else if (key === 'employee' || key === 'account') {
      await expect(panel.locator('[name="managerNote"]')).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'New yearly review', exact: true })).toHaveCount(0);
    }
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download Word', exact: true }).click();
    await download;
    const documentRead = (await calls(page, 'getPerformanceReviewDocument')).at(-1);
    expect(documentRead.args[1]).toBe(people[key].id);
    await panel.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    expect((await calls(page, 'loadPerformanceReviews')).at(-1).args).toEqual([people[key].id]);
    expect(await writes(page)).toEqual([]);
  }
  await preview(page).getByRole('button', { name: 'Return to Super Admin', exact: true }).click();
  await openPerformance(page);
  await expect(workspace(page).getByRole('heading', { name: 'Synthetic P0 scope — MAM', exact: true })).toBeVisible();
  expect((await calls(page, 'loadPerformanceReviews')).at(-1).args[0]).toBeUndefined();
  expect(await writes(page)).toEqual([]);
});

for (const returnToA of [false, true]) test(`late Performance manager load cannot replace ${returnToA ? 'a newer same-target preview' : 'Employee'}`, async ({ page }) => {
  await selectProfile(page, 'manager'); await openPerformance(page);
  await expect(workspace(page).locator('[name="managerNote"]')).toHaveValue('Synthetic A report private synthetic note');
  await page.evaluate(id => { window.unifiedRoleFixture.setPerformanceLabel(id, 'OLD'); window.unifiedRoleFixture.holdNext('loadPerformanceReviews', id); }, people.manager.id);
  await workspace(page).getByRole('button', { name: 'Reload', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`loadPerformanceReviews:${people.manager.id}`);
  await selectProfile(page, 'employee'); await openPerformance(page);
  await expect(workspace(page).locator('[name="self-0"]')).toHaveValue('Synthetic Employee answer 1');
  await expect(workspace(page).locator('[name="managerNote"]')).toHaveCount(0);
  if (returnToA) {
    await selectProfile(page, 'managerB'); await openPerformance(page);
    await expect(workspace(page).locator('[name="managerNote"]')).toHaveValue('Synthetic B report private synthetic note');
    await page.evaluate(id => window.unifiedRoleFixture.setPerformanceLabel(id, 'FRESH'), people.manager.id);
    await selectProfile(page, 'manager'); await openPerformance(page);
    await expect(workspace(page).locator('[name="managerNote"]')).toHaveValue('Synthetic A report private synthetic note FRESH');
  }
  const before = await page.evaluate(id => window.unifiedRoleFixture.responses.filter(item => item.key === `loadPerformanceReviews:${id}`).length, people.manager.id);
  await page.evaluate(id => window.unifiedRoleFixture.finish('loadPerformanceReviews', id), people.manager.id);
  await expect.poll(() => page.evaluate(id => window.unifiedRoleFixture.responses.filter(item => item.key === `loadPerformanceReviews:${id}`).length, people.manager.id)).toBe(before + 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (returnToA) await expect(workspace(page).locator('[name="managerNote"]')).toHaveValue('Synthetic A report private synthetic note FRESH');
  else {
    await expect(workspace(page).locator('[name="self-0"]')).toHaveValue('Synthetic Employee answer 1');
    await expect(workspace(page).locator('[name="managerNote"]')).toHaveCount(0);
  }
  await assertReadOnly(page);
});

test('actual manager Performance remains editable outside Change profile preview', async ({ page }) => {
  await page.goto('/?fixture=unified-roles&performance-preview&actor-role=manager');
  await openPerformance(page);
  const panel = workspace(page);
  await expect(panel.locator('[name="managerNote"]')).toBeEnabled();
  await panel.locator('[name="managerNote"]').fill('Synthetic native manager draft');
  await expect(panel.locator('[name="managerNote"]')).toHaveValue('Synthetic native manager draft');
  await expect(panel.locator('[name="self-0"]')).toBeDisabled();
  await expect(panel.locator('[name="meeting-date"]')).toBeEnabled();
  await panel.locator('[name="held"]').check();
  await expect(panel.locator('[name="held"]')).toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save manager draft', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'New yearly review', exact: true })).toBeEnabled();
  await panel.getByRole('navigation', { name: 'Review list' }).getByRole('button').filter({ hasText: people.manager.name }).click();
  await expect(panel.locator('[name="self-0"]')).toBeEnabled();
  await panel.locator('[name="self-0"]').fill('Synthetic native self draft');
  await expect(panel.locator('[name="self-0"]')).toHaveValue('Synthetic native self draft');
  expect((await calls(page, 'loadPerformanceReviews')).at(-1).args[0]).toBeUndefined();
  expect(await writes(page)).toEqual([]);
});
