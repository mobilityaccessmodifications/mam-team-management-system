import { test, expect } from '@playwright/test';

const scheduleId = '88000000-0000-4000-8000-000000000001';
const checkInId = '66000000-0000-4000-8000-000000000001';
const ownRoute = '/?fixture=unified-roles&tasks=combined&schedule-tasks&subscription-reviews=employee';
const reviewerRoute = '/?fixture=unified-roles&tasks=combined&schedule-tasks';
const scheduleRowName = "Open Synthetic Employee's Work schedule change";
const checkInRowName = "Open Synthetic Check-in Employee's 1-month check-in";
const workspace = page => page.getByRole('region', { name: 'Tasks', exact: true });
const details = page => page.getByRole('region', { name: 'Task details', exact: true });
const notes = page => details(page).getByLabel('Notes', { exact: true });
const calls = (page, name) => page.evaluate(action => window.unifiedRoleFixture.calls.filter(call => call.name === action), name);

async function openTasks(page) {
  await page.getByRole('complementary', { name: 'People Hub navigation' }).getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('tablist', { name: 'People sections' }).getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(workspace(page).getByRole('button', { name: scheduleRowName, exact: true })).toBeVisible();
  await workspace(page).getByRole('combobox', { name: 'Type', exact: true }).selectOption('work_schedule');
  await workspace(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('submitted');
  await expect(workspace(page).getByRole('button', { name: /^Open / })).toHaveCount(1);
  await workspace(page).getByRole('button', { name: scheduleRowName, exact: true }).click();
  await expect(details(page)).toBeVisible();
}

test.beforeEach(async ({ page, context, baseURL }) => {
  page.scheduleErrors = [];
  page.on('pageerror', error => page.scheduleErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test.afterEach(async ({ page }) => {
  expect(page.scheduleErrors).toEqual([]);
  expect(await page.evaluate(() => window.unifiedRoleFixture.unexpected)).toEqual([]);
});

test('pending own work schedule tasks show request details and save Notes across a fresh mount', async ({ page }) => {
  await page.goto(ownRoute);
  await openTasks(page);
  for (const text of [
    'Current schedule', 'Mon 09:00–17:00', 'Requested schedule', 'Tue 10:00–16:00',
    'Request reason', 'Synthetic change to support a study timetable', 'Submitted by', 'Synthetic Employee',
  ]) await expect(details(page)).toContainText(text);
  await expect(details(page).getByRole('button', { name: 'Approve request', exact: true })).toHaveCount(0);
  await expect(details(page).getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
  await expect(notes(page)).toBeEditable();
  await notes(page).fill('Synthetic saved work schedule notes');
  await details(page).getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect.poll(() => calls(page, 'saveTaskNotes')).toHaveLength(1);
  expect((await calls(page, 'saveTaskNotes'))[0].args).toEqual([{
    target: { kind: 'work_schedule', taskId: scheduleId }, text: 'Synthetic saved work schedule notes', version: 0,
  }]);
  await expect(details(page).getByRole('status').filter({ hasText: 'Notes saved.' })).toHaveCount(1);
  await page.reload();
  await openTasks(page);
  await expect(notes(page)).toHaveValue('Synthetic saved work schedule notes');
});

test('Change Profile preserves scoped schedule decisions while Notes stay read-only', async ({ page }) => {
  const managerId = '11000000-0000-4000-8000-000000000004';
  await page.goto(reviewerRoute);
  await page.getByRole('region', { name: 'Employee access preview' }).locator('button[aria-haspopup="dialog"]').click();
  await page.getByRole('dialog', { name: 'Change profile', exact: true }).getByRole('button', { name: /Synthetic Manager/ }).click();
  await openTasks(page);
  await expect(notes(page)).toHaveJSProperty('readOnly', true);
  await expect(details(page).getByRole('button', { name: 'Save notes', exact: true })).toHaveCount(0);
  await details(page).getByLabel('Decision reason', { exact: true }).fill('Synthetic manager preview decision');
  await details(page).getByRole('button', { name: 'Approve request', exact: true }).click();
  await expect(details(page)).toHaveCount(0);
  expect((await calls(page, 'reviewEmployeeWorkScheduleChange'))[0].args).toEqual([{
    requestId: scheduleId, decision: 'approved', reason: 'Synthetic manager preview decision',
  }]);
  const noteReads = await calls(page, 'getTaskNotes');
  expect(noteReads).toHaveLength(1);
  expect(noteReads[0].args).toEqual([{ kind: 'work_schedule', taskId: scheduleId }, managerId]);
  expect(await calls(page, 'saveTaskNotes')).toEqual([]);
  expect((await calls(page, 'loadEmployeeWorkScheduleWorkspace')).some(call => call.args[0] === managerId)).toBe(true);
});

for (const [buttonName, decision] of [['Approve request', 'approved'], ['Decline', 'declined']]) {
  test(`standalone reviewers require a reason and dispatch ${decision} once`, async ({ page }) => {
    await page.goto(reviewerRoute);
    await openTasks(page);
    const reason = details(page).getByLabel('Decision reason', { exact: true });
    const decide = details(page).getByRole('button', { name: buttonName, exact: true });
    await expect(reason).toBeVisible();
    await expect(decide).toBeEnabled();
    await decide.click();
    await expect(details(page).getByRole('alert')).toContainText('Enter a reason');
    expect(await calls(page, 'reviewEmployeeWorkScheduleChange')).toEqual([]);
    await reason.fill('Synthetic documented schedule decision');
    await page.evaluate(id => window.unifiedRoleFixture.holdNext('reviewEmployeeWorkScheduleChange', id), scheduleId);
    await decide.click();
    await expect(decide).toBeDisabled();
    await decide.dispatchEvent('click');
    await expect.poll(() => calls(page, 'reviewEmployeeWorkScheduleChange')).toHaveLength(1);
    expect((await calls(page, 'reviewEmployeeWorkScheduleChange'))[0].args).toEqual([{
      requestId: scheduleId, decision, reason: 'Synthetic documented schedule decision',
    }]);
    await page.evaluate(id => window.unifiedRoleFixture.finish('reviewEmployeeWorkScheduleChange', id), scheduleId);
    await expect(details(page)).toHaveCount(0);
    await expect(workspace(page).getByRole('button', { name: scheduleRowName, exact: true })).toHaveCount(0);
    await expect(workspace(page).getByRole('status').filter({ hasText: `Schedule request ${decision}.` })).toHaveCount(1);
    expect(await calls(page, 'list_my_subscription_review_tasks')).toEqual([]);
  });
}

test('a disappearing task releases a held Notes save so the list remains usable', async ({ page }) => {
  await page.goto(ownRoute);
  await openTasks(page);
  await expect(notes(page)).toBeEditable();
  await notes(page).fill('Synthetic note finishing after request cancellation');
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('saveTaskNotes', id), scheduleId);
  await details(page).getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`saveTaskNotes:${scheduleId}`);
  await page.evaluate(() => {
    window.unifiedRoleFixture.removeScheduleRequest();
    window.dispatchEvent(new Event('focus'));
  });
  await expect(details(page)).toHaveCount(0);
  await workspace(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
  await workspace(page).getByRole('combobox', { name: 'Type', exact: true }).selectOption('all');
  const row = workspace(page).getByRole('button', { name: checkInRowName, exact: true });
  await expect(row).toBeEnabled();
  await row.click();
  await expect(notes(page)).toBeEditable();
  await expect(notes(page)).toHaveValue('');
  await page.evaluate(id => window.unifiedRoleFixture.finish('saveTaskNotes', id), scheduleId);
  await expect(notes(page)).toHaveValue('');
  await expect(workspace(page).getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled();
});

test('a late schedule decision cannot close a newer task or release its pending Notes save', async ({ page }) => {
  await page.goto(reviewerRoute);
  await openTasks(page);
  await details(page).getByLabel('Decision reason', { exact: true }).fill('Synthetic decision completing after request removal');
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('reviewEmployeeWorkScheduleChange', id), scheduleId);
  await details(page).getByRole('button', { name: 'Approve request', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`reviewEmployeeWorkScheduleChange:${scheduleId}`);
  await page.evaluate(() => {
    window.unifiedRoleFixture.removeScheduleRequest();
    window.dispatchEvent(new Event('focus'));
  });
  await expect(details(page)).toHaveCount(0);
  await expect(workspace(page).getByRole('searchbox', { name: 'Search tasks', exact: true })).toBeFocused();
  await workspace(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
  await workspace(page).getByRole('combobox', { name: 'Type', exact: true }).selectOption('all');
  const row = workspace(page).getByRole('button', { name: checkInRowName, exact: true });
  await expect(row).toBeEnabled();
  await row.click();
  await expect(notes(page)).toBeEditable();
  await notes(page).fill('Synthetic newer task note still saving');
  await page.evaluate(id => window.unifiedRoleFixture.holdNext('saveTaskNotes', id), checkInId);
  await details(page).getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedRoleFixture.pendingKeys())).toContain(`saveTaskNotes:${checkInId}`);
  const workspaceReads = (await calls(page, 'loadEmployeeWorkScheduleWorkspace')).length;
  await page.evaluate(id => window.unifiedRoleFixture.finish('reviewEmployeeWorkScheduleChange', id), scheduleId);
  await expect.poll(async () => (await calls(page, 'loadEmployeeWorkScheduleWorkspace')).length).toBeGreaterThan(workspaceReads);
  await expect(details(page)).toContainText('1-month check-in');
  await expect(notes(page)).toHaveValue('Synthetic newer task note still saving');
  await expect(notes(page)).toBeDisabled();
  await expect(details(page).getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(details(page).getByRole('button', { name: 'Close task details', exact: true })).toBeDisabled();
  await expect(row).toBeDisabled();
  await expect(workspace(page).getByRole('button', { name: 'Refresh tasks', exact: true })).toBeDisabled();
  await expect(workspace(page).getByRole('status').filter({ hasText: 'Schedule request approved.' })).toHaveCount(0);
  await page.evaluate(id => window.unifiedRoleFixture.finish('saveTaskNotes', id), checkInId);
  await expect(details(page).getByRole('status').filter({ hasText: 'Notes saved.' })).toHaveCount(1);
  await expect(notes(page)).toBeEditable();
  await expect(row).toBeEnabled();
  await expect(workspace(page).getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled();
  expect(await calls(page, 'reviewEmployeeWorkScheduleChange')).toHaveLength(1);
  expect(await calls(page, 'saveTaskNotes')).toHaveLength(1);
});
