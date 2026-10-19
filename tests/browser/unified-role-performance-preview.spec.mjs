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
async function assertReadOnly(page, managerScope = false) {
  const panel = workspace(page);
  await expect(panel.locator('[name="self-0"]')).toBeVisible();
  const fields = panel.locator('input, textarea, select');
  expect(await fields.count()).toBeGreaterThan(0);
  for (const field of await fields.all()) await expect(field).toBeDisabled();
  for (const button of await panel.getByRole('button', { name: /^(?:New yearly review|Save self draft|Submit self assessment|Save manager draft|Complete manager assessment|Save meeting|Finalise review|Reconcile update)$/ }).all()) {
    if (managerScope && await button.textContent() === 'New yearly review') continue;
    await expect(button).toBeDisabled();
  }
  for (const form of await panel.locator('form').all()) await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(panel.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  expect(await writes(page)).toEqual([]);
}
async function assertManagerEditable(page) {
  const panel = workspace(page);
  await expect(panel.locator('[name="managerNote"]')).toBeEnabled();
  await expect(panel.locator('[name="self-0"]')).toBeDisabled();
  await expect(panel.locator('[name="meeting-date"]')).toBeEnabled();
  await expect(panel.locator('[name="held"]')).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'New yearly review', exact: true })).toBeEnabled();
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

test('actual LeaveDemo P0 profile switching permits assigned manager delegation and keeps other audiences read-only', async ({ page }) => {
  test.setTimeout(60_000);
  await openPerformance(page);
  await expect(workspace(page).getByRole('heading', { name: 'Synthetic P0 scope — MAM', exact: true })).toBeVisible();
  for (const [key, name] of [['manager', 'Synthetic A report'], ['employee', 'Synthetic Employee'], ['account', 'Synthetic Account'], ['admin', 'Synthetic HR scope'], ['managerB', 'Synthetic B report']]) {
    await selectProfile(page, key); await openPerformance(page);
    const panel = workspace(page);
    await expect(panel.getByRole('heading', { name: `${name} — MAM`, exact: true })).toBeVisible();
    if (key.startsWith('manager')) await assertManagerEditable(page); else await assertReadOnly(page);
    expect((await calls(page, 'loadPerformanceReviews')).at(-1).args).toEqual([people[key].id]);
    const rowButtons = panel.getByRole('navigation', { name: 'Review list' }).getByRole('button');
    await expect(rowButtons).toHaveCount(key.startsWith('manager') ? 2 : 1);
    if (key.startsWith('manager')) {
      await rowButtons.filter({ hasText: people[key].name }).click();
      await expect(panel.locator('[name="self-0"]')).toHaveValue(`${people[key].name} answer 1`);
      await assertReadOnly(page, true);
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
  if (returnToA) await assertManagerEditable(page); else await assertReadOnly(page);
});

test('yearly review form uses the orange primary button and current Melbourne year with a seven-day due date', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-31T13:30:00Z'));
  await selectProfile(page, 'manager'); await openPerformance(page);
  const panel = workspace(page);
  const button = panel.getByRole('button', { name: 'New yearly review', exact: true });
  await expect(button).toHaveCSS('background-color', 'rgb(195, 77, 20)');
  await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
  await button.hover();
  await expect(button).toHaveCSS('background-color', 'rgb(168, 63, 13)');
  await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
  await button.click();
  const create = panel.getByRole('form', { name: 'New yearly review', exact: true });
  await expect(create.getByRole('combobox', { name: 'Cycle', exact: true })).toHaveValue('2027');
  await expect(create.locator('[name="start-dueDate"]')).toHaveValue('2027-01-08');
  await create.getByRole('combobox', { name: 'Cycle', exact: true }).selectOption('2026');
  await create.locator('[name="start-dueDate"]').fill('2027-01-10');
  await button.click();
  await expect(create.locator('[name="start-cycle"]')).toHaveValue('2026');
  await expect(create.locator('[name="start-dueDate"]')).toHaveValue('2027-01-10');
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.clock.setFixedTime(new Date('2027-01-01T13:30:00Z'));
  await button.click();
  await expect(create.locator('[name="start-cycle"]')).toHaveValue('2027');
  await expect(create.locator('[name="start-dueDate"]')).toHaveValue('2027-01-09');
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await writes(page)).toEqual([]);
});

test('P0 creates and completes assigned manager work with the target on every write while own self stays read-only', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T00:00:00Z'));
  await selectProfile(page, 'manager'); await openPerformance(page);
  const panel = workspace(page);
  await assertManagerEditable(page);
  await panel.getByRole('button', { name: 'New yearly review', exact: true }).click();
  const create = panel.getByRole('form', { name: 'New yearly review', exact: true });
  await panel.getByRole('navigation', { name: 'Review employees' }).getByRole('button', { name: 'Synthetic A candidate — MAM', exact: true }).click();
  await create.locator('[name="start-cycle"]').selectOption('2027');
  await create.locator('[name="start-dueDate"]').fill('2027-11-30');
  await create.getByRole('button', { name: 'Start review', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Review created.');
  await expect(panel.getByRole('heading', { name: 'Synthetic A candidate — MAM', exact: true })).toBeVisible();
  expect((await calls(page, 'startPerformanceReview')).at(-1).args[1]).toBe(people.manager.id);
  await panel.getByRole('navigation', { name: 'Review list' }).getByRole('button').filter({ hasText: 'Synthetic A report' }).click();
  await panel.locator('[name="managerNote"]').fill('Synthetic delegated manager evidence');
  await panel.getByRole('button', { name: 'Save manager draft', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');
  await panel.getByRole('button', { name: 'Complete manager assessment', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Submitted.');
  await panel.locator('[name="meeting-notes"]').fill('Synthetic delegated meeting');
  await panel.getByRole('button', { name: 'Save meeting', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');
  await panel.locator('[name="held"]').check();
  await panel.getByRole('button', { name: 'Finalise review', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Submitted.');
  await expect(panel.locator('[name="managerNote"]')).toBeDisabled();
  const mutations = await calls(page, 'mutatePerformanceReview');
  expect(mutations.map(call => call.args[0].command)).toEqual(['save_manager', 'complete_manager', 'save_meeting', 'submit_review']);
  expect(mutations.every(call => call.args[1] === people.manager.id)).toBe(true);
  const before = (await writes(page)).length;
  await panel.getByRole('navigation', { name: 'Review list' }).getByRole('button').filter({ hasText: people.manager.name }).click();
  await expect(panel.locator('[name="self-0"]')).toBeDisabled();
  await panel.getByRole('form', { name: 'Self assessment', exact: true }).evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect((await writes(page)).length).toBe(before);
  await expect(panel.locator('[name="managerNote"]')).toHaveCount(0);
});

test('P0 uncertain manager creation reconciles the original target without replaying create', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T00:00:00Z'));
  await selectProfile(page, 'manager'); await openPerformance(page);
  const panel = workspace(page);
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('startPerformanceReview', id), people.manager.id);
  await panel.getByRole('button', { name: 'New yearly review', exact: true }).click();
  const create = panel.getByRole('form', { name: 'New yearly review', exact: true });
  await panel.getByRole('navigation', { name: 'Review employees' }).getByRole('button', { name: 'Synthetic A candidate — MAM', exact: true }).click();
  await create.locator('[name="start-cycle"]').selectOption('2027');
  await create.locator('[name="start-dueDate"]').fill('2027-11-30');
  await create.getByRole('button', { name: 'Start review', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`startPerformanceReview:${people.manager.id}`);
  await page.evaluate(id => window.unifiedRoleFixture.rejectPending('startPerformanceReview', id), people.manager.id);
  await expect(panel.getByRole('alert')).toContainText('Reconcile before submitting again.');
  await expect(create.getByRole('button', { name: 'Start review', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(create.getByRole('button', { name: 'Start review', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Reconcile update', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Update confirmed.');
  await expect(panel.getByRole('heading', { name: 'Synthetic A candidate — MAM', exact: true })).toBeVisible();
  const starts = await calls(page, 'startPerformanceReview'), reconciles = await calls(page, 'reconcilePerformanceReviewOperation');
  expect(starts).toHaveLength(1); expect(reconciles).toHaveLength(1);
  expect(reconciles[0].args).toEqual([{ operationId: starts[0].args[0].operationId, reviewId: null }, people.manager.id]);
});

test('a late delegated manager write cannot replace a new Employee target or release its private fields', async ({ page }) => {
  await selectProfile(page, 'manager'); await openPerformance(page);
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('mutatePerformanceReview', id), people.manager.id);
  await workspace(page).locator('[name="managerNote"]').fill('Synthetic retired manager note');
  await workspace(page).getByRole('button', { name: 'Save manager draft', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`mutatePerformanceReview:${people.manager.id}`);
  await selectProfile(page, 'employee'); await openPerformance(page);
  await expect(workspace(page).locator('[name="self-0"]')).toHaveValue('Synthetic Employee answer 1');
  await page.evaluate(id => window.unifiedRoleFixture.finish('mutatePerformanceReview', id), people.manager.id);
  await expect.poll(() => page.evaluate(id => window.unifiedRoleFixture.responses.some(item => item.key === `mutatePerformanceReview:${id}`), people.manager.id)).toBe(true);
  await expect(workspace(page).locator('[name="self-0"]')).toHaveValue('Synthetic Employee answer 1');
  await expect(workspace(page).locator('[name="managerNote"]')).toHaveCount(0);
  await expect(workspace(page).getByRole('button', { name: 'Reconcile update', exact: true })).toHaveCount(0);
  expect((await writes(page)).map(call => call.args[1])).toEqual([people.manager.id]);
  await expect(workspace(page).locator('[name="self-0"]')).toBeDisabled();
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
