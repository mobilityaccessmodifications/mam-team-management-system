import { test, expect } from '@playwright/test';

const checkInId = '66000000-0000-4000-8000-000000000001';
const subscriptionId = '33000000-0000-4000-8000-000000000010';
const combinedRoute = '/?fixture=unified-roles&tasks=combined&subscription-reviews=register-manager&actor-role=manager';
const pagedRoute = `${combinedRoute}&paged-tasks`;
const checkInRowName = "Open Synthetic Check-in Employee's 1-month check-in";
const subscriptionRowName = "Open Synthetic due review's Quarterly subscription review";
const checkInTarget = { kind: 'check_in', taskId: checkInId };
const subscriptionTarget = { kind: 'subscription_review', taskId: subscriptionId, reviewOn: '2000-01-01' };
const workspace = page => page.getByRole('region', { name: 'Tasks', exact: true });
const taskRows = page => workspace(page).getByRole('button', { name: /^Open / });
const details = (page, mobile = false) => page.getByRole(mobile ? 'dialog' : 'region', { name: 'Task details', exact: true });
const search = page => workspace(page).getByRole('searchbox', { name: 'Search tasks', exact: true });

async function openTasks(page) {
  await page.getByRole('complementary', { name: 'People Hub navigation' }).getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('tablist', { name: 'People sections' }).getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(workspace(page)).toBeVisible();
  await expect(search(page)).toBeVisible();
}

async function openTask(page, name, mobile = false) {
  await workspace(page).getByRole('button', { name, exact: true }).click();
  await expect(details(page, mobile)).toBeVisible();
  await expect(details(page, mobile).getByLabel('Notes', { exact: true })).toBeVisible();
  return details(page, mobile);
}

async function actionCalls(page, name) {
  return page.evaluate(action => window.unifiedRoleFixture.calls.filter(call => call.name === action), name);
}

test.beforeEach(async ({ page, context, baseURL }) => {
  page.taskErrors = [];
  page.on('pageerror', error => page.taskErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test.afterEach(async ({ page }) => {
  expect(page.taskErrors).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
});

test('Tasks shares search and filters across every task with a right-hand detail pane', async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  await expect(taskRows(page)).toHaveCount(5);
  await expect(search(page)).toHaveCount(1);
  await expect(workspace(page).getByRole('combobox', { name: 'Sort', exact: true })).toBeVisible();
  await search(page).fill('FUTURE');
  await expect(taskRows(page)).toHaveCount(2);
  await search(page).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(taskRows(page)).toHaveCount(5);
  const type = workspace(page).getByRole('combobox', { name: 'Type', exact: true });
  const status = workspace(page).getByRole('combobox', { name: 'Status', exact: true });
  await type.selectOption('subscription_review');
  await expect(taskRows(page)).toHaveCount(2);
  await status.selectOption('paused');
  await expect(taskRows(page)).toHaveCount(1);
  await expect(taskRows(page)).toContainText('Synthetic future review');
  await status.selectOption('active');
  await expect(taskRows(page)).toHaveCount(1);
  await expect(taskRows(page)).toContainText('Synthetic due review');
  await status.selectOption('all');
  await type.selectOption('check_in');
  await expect(taskRows(page)).toHaveCount(3);
  for (const value of ['needs_review', 'ready', 'scheduled']) {
    await status.selectOption(value);
    await expect(taskRows(page)).toHaveCount(1);
  }
  await status.selectOption('all');
  await type.selectOption('all');
  await search(page).fill('check-in employee');
  await expect(taskRows(page)).toHaveCount(2);
  await search(page).fill('');
  const rowNames = await taskRows(page).evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
  for (const name of rowNames) {
    const row = workspace(page).getByRole('button', { name, exact: true });
    await row.click();
    const pane = details(page);
    await expect(pane).toBeVisible();
    await expect(pane.getByLabel('Notes', { exact: true })).toBeVisible();
    const rowBox = await row.boundingBox();
    const paneBox = await pane.boundingBox();
    expect(paneBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 2);
  }
  await openTask(page, "Open Synthetic Check-in Employee's 5-Month No-Surprises Review");
  await expect(details(page)).toContainText('Manager work email is missing');
  await expect(details(page)).toContainText('2 Jan 2000');
  await expect(details(page)).not.toContainText('synthetic private');
});

test('mobile task details contain focus and Escape returns to the selected task', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(combinedRoute);
  await openTasks(page);
  const row = workspace(page).getByRole('button', { name: checkInRowName, exact: true });
  const pane = await openTask(page, checkInRowName, true);
  await expect(pane).toHaveAttribute('aria-modal', 'true');
  await expect(pane).toBeFocused();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    expect(await pane.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('task paging and collapsing preserve the open detail and unsaved Notes', async ({ page }) => {
  await page.goto(pagedRoute);
  await openTasks(page);
  const pagination = workspace(page).getByRole('navigation', { name: 'Task list pagination' });
  await expect(taskRows(page)).toHaveCount(8);
  await expect(pagination).toContainText('Page 1 of 3');
  await expect(pagination.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  const pane = await openTask(page, checkInRowName);
  const notes = pane.getByLabel('Notes', { exact: true });
  await expect(notes).toBeEditable();
  await notes.fill('Synthetic draft retained across paging and collapse');
  const width = (await pane.boundingBox()).width;
  await pagination.getByRole('button', { name: 'Next page' }).click();
  await expect(pagination).toContainText('Page 2 of 3');
  await expect(workspace(page).getByRole('button', { name: checkInRowName, exact: true })).toHaveCount(0);
  await expect(notes).toHaveValue('Synthetic draft retained across paging and collapse');
  const collapse = workspace(page).getByRole('button', { name: 'Collapse task list' });
  await collapse.focus();
  await page.keyboard.press('Enter');
  const expand = workspace(page).getByRole('button', { name: 'Expand task list' });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(pagination).toBeHidden();
  await expect(taskRows(page).first()).toBeHidden();
  expect((await pane.boundingBox()).width).toBeGreaterThan(width);
  await expect(notes).toBeEditable();
  await expect(notes).toHaveValue('Synthetic draft retained across paging and collapse');
  await page.keyboard.press('Enter');
  await expect(pagination).toBeVisible();
  await expect(pagination).toContainText('Page 2 of 3');
  await pagination.getByRole('button', { name: 'Next page' }).click();
  await expect(pagination).toContainText('Page 3 of 3');
  await expect(taskRows(page)).toHaveCount(5);
  await expect(pagination.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await pagination.getByRole('button', { name: 'Previous page' }).click();
  await pagination.getByRole('button', { name: 'Previous page' }).click();
  await expect(workspace(page).getByRole('button', { name: checkInRowName, exact: true })).toHaveAttribute('aria-current', 'true');
  expect(await actionCalls(page, 'getTaskNotes')).toHaveLength(1);
  expect(await actionCalls(page, 'saveTaskNotes')).toEqual([]);
});

test('task filters reset paging and completing the last page returns to a valid page', async ({ page }) => {
  await page.goto(pagedRoute);
  await openTasks(page);
  const pagination = workspace(page).getByRole('navigation', { name: 'Task list pagination' });
  const next = pagination.getByRole('button', { name: 'Next page' });
  await next.click();
  await search(page).fill('Paged Employee');
  await expect(pagination).toContainText('Page 1 of 2');
  await next.click();
  await workspace(page).getByRole('combobox', { name: 'Sort', exact: true }).selectOption('name');
  await expect(pagination).toContainText('Page 1 of 2');
  await next.click();
  await workspace(page).getByRole('combobox', { name: 'Type', exact: true }).selectOption('check_in');
  await expect(pagination).toContainText('Page 1 of 2');
  await search(page).fill('');
  await next.click();
  await workspace(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('ready');
  await expect(pagination).toContainText('Page 1 of 3');
  await next.click();
  await next.click();
  await expect(taskRows(page)).toHaveCount(1);
  await taskRows(page).first().click();
  const pane = details(page);
  const complete = pane.getByRole('button', { name: /complete$/ });
  await expect(complete).toBeEnabled();
  await complete.click();
  await expect(pane).toHaveCount(0);
  await expect(pagination).toContainText('Page 2 of 2');
  await expect(taskRows(page)).toHaveCount(8);
  await expect(next).toBeDisabled();
  await expect(search(page)).toBeFocused();
  await search(page).fill('no synthetic matches');
  await expect(pagination).toContainText('Page 1 of 1');
  await expect(taskRows(page)).toHaveCount(0);
  await expect(pagination.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(next).toBeDisabled();
});

test('a collapsed task list is available again on phone widths with working pagination', async ({ page }) => {
  await page.goto(pagedRoute);
  await openTasks(page);
  await workspace(page).getByRole('button', { name: 'Collapse task list' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(taskRows(page).first()).toBeVisible();
  await expect(workspace(page).getByRole('button', { name: 'Collapse task list' })).toBeHidden();
  const pagination = workspace(page).getByRole('navigation', { name: 'Task list pagination' });
  await pagination.getByRole('button', { name: 'Next page' }).click();
  await expect(pagination).toContainText('Page 2 of 3');
  const row = taskRows(page).first();
  await row.click();
  await expect(details(page, true)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unsaved notes stay with their task when switching details', async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  const first = await openTask(page, checkInRowName);
  await expect(first.getByLabel('Notes', { exact: true })).toBeEditable();
  await first.getByLabel('Notes', { exact: true }).fill('Synthetic unsaved check-in draft');
  const other = await openTask(page, subscriptionRowName);
  await expect(other.getByLabel('Notes', { exact: true })).toHaveValue('');
  await openTask(page, checkInRowName);
  await expect(details(page).getByLabel('Notes', { exact: true })).toHaveValue('Synthetic unsaved check-in draft');
  expect(await actionCalls(page, 'saveTaskNotes')).toEqual([]);
});

test('a transient notes read failure hides the cached draft until Retry notes authorizes access again', async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  const pane = await openTask(page, checkInRowName);
  const notes = pane.getByLabel('Notes', { exact: true });
  await expect(notes).toBeEditable();
  await notes.fill('Synthetic draft retained through a failed read');
  await pane.getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(pane).toHaveCount(0);
  await expect(search(page)).toBeFocused();
  await page.evaluate(id => window.unifiedRoleFixture.failNext('getTaskNotes', id, 'transport'), checkInId);
  await openTask(page, checkInRowName);
  await expect(pane.getByRole('alert')).toContainText('Notes could not be loaded. Try again.');
  await expect(notes).toHaveValue('');
  await expect(notes).toBeDisabled();
  await expect(pane.getByRole('button', { name: 'Save notes', exact: true })).toBeDisabled();
  await expect(pane).not.toContainText('private synthetic provider');
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('getTaskNotes', id), checkInId);
  await pane.getByRole('button', { name: 'Retry notes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`getTaskNotes:${checkInId}`);
  await expect(notes).toHaveValue('');
  await expect(notes).toBeDisabled();
  await page.evaluate(id => window.unifiedRoleFixture.finish('getTaskNotes', id), checkInId);
  await expect(notes).toHaveValue('Synthetic draft retained through a failed read');
  await expect(notes).toBeEditable();
  await expect(pane.getByRole('button', { name: 'Save notes', exact: true })).toBeEnabled();
  expect(await actionCalls(page, 'getTaskNotes')).toHaveLength(3);
  expect(await actionCalls(page, 'saveTaskNotes')).toEqual([]);
});

for (const [kind, rowName, target] of [
  ['check-in', checkInRowName, checkInTarget],
  ['subscription review', subscriptionRowName, subscriptionTarget],
]) test(`saved ${kind} notes survive a fresh workspace mount with the correct task version`, async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  const pane = await openTask(page, rowName);
  await expect(pane.getByLabel('Notes', { exact: true })).toBeEditable();
  await pane.getByLabel('Notes', { exact: true }).fill(`Synthetic saved ${kind} notes`);
  await pane.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect.poll(() => actionCalls(page, 'saveTaskNotes')).toHaveLength(1);
  expect((await actionCalls(page, 'saveTaskNotes'))[0].args).toEqual([{ target, text: `Synthetic saved ${kind} notes`, version: 0 }]);
  await page.reload();
  await openTasks(page);
  await openTask(page, rowName);
  await expect(details(page).getByLabel('Notes', { exact: true })).toHaveValue(`Synthetic saved ${kind} notes`);
});

test('stale note saves preserve the draft and show safe conflict feedback', async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  const pane = await openTask(page, checkInRowName);
  await expect(pane.getByLabel('Notes', { exact: true })).toBeEditable();
  await pane.getByLabel('Notes', { exact: true }).fill('Synthetic conflicting draft');
  await page.evaluate(target => window.unifiedRoleFixture.setTaskNotes(target, 'Synthetic newer saved note', 1), checkInTarget);
  await pane.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(pane.getByRole('alert')).toContainText('Notes have changed');
  await expect(pane.getByLabel('Notes', { exact: true })).toHaveValue('Synthetic conflicting draft');
  expect(await actionCalls(page, 'saveTaskNotes')).toHaveLength(1);
  await expect(pane).not.toContainText('synthetic private');
});

for (const [kind, rowName, action, id, buttonName] of [
  ['check-in', checkInRowName, 'completeMyEmployeeCheckInTask', checkInId, "Mark Synthetic Check-in Employee's 1-month check-in complete"],
  ['subscription review', subscriptionRowName, 'completeMySubscriptionReviewTask', subscriptionId, "Mark Synthetic due review's subscription review done"],
]) test(`pending ${kind} completion prevents editing or saving Notes`, async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  const pane = await openTask(page, rowName);
  const notes = pane.getByLabel('Notes', { exact: true });
  await expect(notes).toBeEditable();
  await workspace(page).getByRole('button', { name: rowName, exact: true }).click();
  await expect(pane.getByRole('button', { name: buttonName, exact: true })).toBeEnabled();
  await page.evaluate(({ action, id }) => window.unifiedRoleFixture.holdNext(action, id), { action, id });
  await pane.getByRole('button', { name: buttonName, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`${action}:${id}`);
  await expect(notes).toBeDisabled();
  await expect(pane.getByRole('button', { name: 'Save notes', exact: true })).toBeDisabled();
  expect(await actionCalls(page, 'saveTaskNotes')).toEqual([]);
  await page.evaluate(({ action, id }) => window.unifiedRoleFixture.finish(action, id), { action, id });
  await expect(pane).toHaveCount(0);
});

test('reopening a dirty task keeps completion disabled during the Notes authorization read', async ({ page }) => {
  await page.goto(combinedRoute);
  await openTasks(page);
  const pane = await openTask(page, checkInRowName);
  await expect(pane.getByLabel('Notes', { exact: true })).toBeEditable();
  await pane.getByLabel('Notes', { exact: true }).fill('Synthetic cached draft awaiting authorization');
  await pane.getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(pane).toHaveCount(0);
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('getTaskNotes', id), checkInId);
  await openTask(page, checkInRowName);
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`getTaskNotes:${checkInId}`);
  const complete = pane.getByRole('button', { name: "Mark Synthetic Check-in Employee's 1-month check-in complete", exact: true });
  await expect(pane.getByLabel('Notes', { exact: true })).toBeDisabled();
  await expect(complete).toBeDisabled();
  await page.evaluate(id => window.unifiedRoleFixture.finish('getTaskNotes', id), checkInId);
  await expect(pane.getByLabel('Notes', { exact: true })).toHaveValue('Synthetic cached draft awaiting authorization');
  await expect(pane.getByLabel('Notes', { exact: true })).toBeEditable();
  await expect(complete).toBeDisabled();
  expect(await actionCalls(page, 'completeMyEmployeeCheckInTask')).toEqual([]);
});

test('Change Profile shows task notes read-only and keeps subscription completion unavailable', async ({ page }) => {
  const managerId = '11000000-0000-4000-8000-000000000004';
  await page.goto('/?fixture=unified-roles&tasks=combined&subscription-reviews=preview-register-manager');
  await page.evaluate(id => window.unifiedRoleFixture.setSubscriptionGrants(id, true, false), managerId);
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: /Synthetic Manager/ }).click();
  await openTasks(page);
  for (const rowName of [checkInRowName, subscriptionRowName]) {
    const pane = await openTask(page, rowName);
    await expect(pane.getByLabel('Notes', { exact: true })).toHaveJSProperty('readOnly', true);
    await expect(pane.getByRole('button', { name: 'Save notes', exact: true })).toHaveCount(0);
  }
  await expect(details(page).getByRole('button', { name: "Mark Synthetic due review's subscription review done", exact: true })).toHaveCount(0);
  expect(await actionCalls(page, 'saveTaskNotes')).toEqual([]);
  expect(await actionCalls(page, 'completeMyEmployeeCheckInTask')).toEqual([]);
  expect(await actionCalls(page, 'completeMySubscriptionReviewTask')).toEqual([]);
  const noteReads = await actionCalls(page, 'getTaskNotes');
  expect(noteReads).toHaveLength(2);
  expect(noteReads.every(call => call.args[1] === managerId)).toBe(true);
});

test('subscription review errors leave check-in tasks available without exposing provider details', async ({ page }) => {
  await page.goto(`${combinedRoute}&subscription-review-error`);
  await openTasks(page);
  await expect(workspace(page).getByRole('alert')).toContainText('Subscription review tasks could not be loaded');
  await expect(taskRows(page)).toHaveCount(3);
  await openTask(page, checkInRowName);
  await expect(details(page)).toContainText('1-month check-in');
  await expect(workspace(page)).not.toContainText('synthetic private provider detail');
});

test('standalone system administrators do not request employee-only subscription review tasks', async ({ page }) => {
  await page.goto('/?fixture=unified-roles&tasks=combined');
  await openTasks(page);
  await expect(taskRows(page)).toHaveCount(3);
  expect(await actionCalls(page, 'list_my_subscription_review_tasks')).toEqual([]);
  expect(await actionCalls(page, 'list_subscription_review_tasks_for_preview')).toEqual([]);
  await expect(workspace(page).getByRole('alert')).toHaveCount(0);
});

test('mobile check-in completion dispatches once and restores search focus when its row disappears', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(combinedRoute);
  await openTasks(page);
  const pane = await openTask(page, checkInRowName, true);
  const complete = pane.getByRole('button', { name: /^(Mark|Marking) Synthetic Check-in Employee's 1-month check-in complete$/ });
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('completeMyEmployeeCheckInTask', id), checkInId);
  await complete.click();
  await expect(complete).toBeDisabled();
  await complete.dispatchEvent('click');
  await expect.poll(() => actionCalls(page, 'completeMyEmployeeCheckInTask')).toHaveLength(1);
  await page.evaluate(id => window.unifiedRoleFixture.finish('completeMyEmployeeCheckInTask', id), checkInId);
  await expect(pane).toHaveCount(0);
  await expect(workspace(page).getByRole('button', { name: checkInRowName, exact: true })).toHaveCount(0);
  await expect(search(page)).toBeFocused();
  expect((await actionCalls(page, 'completeMyEmployeeCheckInTask'))[0].args).toEqual([checkInId]);
});
