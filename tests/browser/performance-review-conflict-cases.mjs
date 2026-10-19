import { test, expect } from '@playwright/test';
import { workspace, review, failure, ids } from '../performance-review-fixtures.mjs';

const origin = process.env.MAM_PERFORMANCE_ORIGIN;
const field = (page, name) => page.locator(`[name="${name}"]`);
const calls = (page, name) => page.evaluate(name => window.performanceReviewFixture.calls.filter(call => call.name === name), name);
const enqueue = (page, name, result) => page.evaluate(({ name, result }) => window.performanceReviewFixture.enqueue(name, result), { name, result });
const terminal = (audience, kind) => {
  const row = review(audience, 'MAM', audience === 'employee' ? { selfRevision: 'self:7' } : { managerRevision: 'manager:0:7' });
  if (kind === 'terminal') {
    if (audience === 'employee') { row.selfSubmittedAt = '2026-10-16T01:00:00Z'; row.selfStatus = 'manager_review'; }
    else row.finalisedAt = '2026-10-16T01:00:00Z';
  } else row.capabilities = { ...row.capabilities, ...(audience === 'employee'
    ? { saveSelf: false, submitSelf: false } : { saveManager: false, completeManager: false, saveMeeting: false, submitReview: false }) };
  return row;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.am04Gestures = [];
    for (const type of ['click', 'input', 'change']) document.addEventListener(type, event => {
      const target = event.target;
      if (target instanceof HTMLElement) window.am04Gestures.push({ type, trusted: event.isTrusted,
        tag: target.tagName, name: target.getAttribute('name'), button: target.tagName === 'BUTTON' ? target.textContent : null });
    }, true);
  });
});
test.afterEach(async ({ page }, info) => {
  if (!info.title.startsWith('AM-04 browser')) return;
  await info.attach('am04-component-observations', { contentType: 'application/json', body: Buffer.from(JSON.stringify(
    await page.evaluate(() => ({ gestures: window.am04Gestures, calls: window.performanceReviewFixture.calls,
      unexpected: window.performanceReviewFixture.unexpected })), null, 2)) });
  if (info.title.endsWith('explicit save completes')) await page.screenshot({ path: info.outputPath('am04-saved.png') });
});

for (const audience of ['employee', 'manager']) test(`AM-04 browser ${audience} conflict Reload retains draft and explicit save completes`, async ({ page }) => {
  await page.goto(`${origin}/?audience=${audience}&company=MAM`);
  const name = audience === 'employee' ? 'self-0' : 'manager-0';
  const label = audience === 'employee' ? 'Save self draft' : 'Save manager draft';
  const revision = audience === 'employee' ? 'self:1' : 'manager:0:1';
  await field(page, name).fill('Browser synthetic conflict draft');
  if (audience === 'manager') {
    await field(page, 'managerNote').fill('PRIVATE-BROWSER-CONFLICT-NOTE');
    await field(page, 'summary').fill('Browser conflict summary');
    await field(page, 'rating-0').selectOption('3 Exceeds expectations');
    await field(page, 'meeting-notes').fill('Browser unsaved meeting draft');
  }
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  const first = (await calls(page, 'mutatePerformanceReview'))[0].args[0];
  const fresh = review(audience, 'MAM', audience === 'employee'
    ? { selfRevision: revision, selfAnswers: Array(12).fill('Different authoritative answer') }
    : { managerRevision: revision, managerAnswers: Array(12).fill('Different authoritative feedback') });
  await enqueue(page, 'loadPerformanceReviews', { ok: true, data: workspace(audience, 'MAM', { reviews: [fresh] }) });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(field(page, name)).toHaveValue('Browser synthetic conflict draft');
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(1);
  if (audience === 'manager') {
    await expect(field(page, 'managerNote')).toHaveValue('PRIVATE-BROWSER-CONFLICT-NOTE');
    await expect(field(page, 'meeting-notes')).toHaveValue('Browser unsaved meeting draft');
  }
  await page.evaluate(() => window.performanceReviewFixture.holdNext('mutatePerformanceReview'));
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForFunction(() => window.performanceReviewFixture.pending().some(item => item.name === 'mutatePerformanceReview'));
  const second = (await calls(page, 'mutatePerformanceReview'))[1].args[0];
  expect(second.expectedRevision).toBe(revision);
  expect(second.operationId).not.toBe(first.operationId);
  expect(second.input).toEqual(first.input);
  const saved = { ...fresh, ...(audience === 'employee' ? { selfRevision: 'self:2', selfAnswers: second.input.answers }
    : { managerRevision: 'manager:0:2', managerAnswers: second.input.answers, ratings: second.input.ratings,
      summary: second.input.summary, overallRating: second.input.overallRating, managerNote: second.input.managerNote }) };
  await page.evaluate(result => window.performanceReviewFixture.release('mutatePerformanceReview', result),
    { ok: true, committed: true, operationId: second.operationId, review: saved });
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(field(page, name)).toHaveValue('Browser synthetic conflict draft');
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(2);
  const trusted = await page.evaluate(() => window.am04Gestures.filter(event => event.trusted));
  expect(trusted.filter(event => event.type === 'click' && event.button === label)).toHaveLength(2);
  expect(trusted.filter(event => event.type === 'click' && event.button === 'Reload')).toHaveLength(1);
  expect(trusted.some(event => event.type === 'input' && event.name === name)).toBe(true);
});

for (const audience of ['employee', 'manager']) for (const kind of ['terminal', 'capability']) test(`AM-04 browser ${audience} ${kind} conflict Reload retains a read-only draft`, async ({ page }) => {
  await page.goto(`${origin}/?audience=${audience}`);
  const name = audience === 'employee' ? 'self-0' : 'manager-0';
  const label = audience === 'employee' ? 'Save self draft' : 'Save manager draft';
  await field(page, name).fill('Read-only browser conflict draft');
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  await enqueue(page, 'loadPerformanceReviews', { ok: true, data: workspace(audience, 'MAM', { reviews: [terminal(audience, kind)] }) });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(field(page, name)).toHaveValue('Read-only browser conflict draft');
  await expect(field(page, name)).toBeDisabled();
  await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  for (const form of audience === 'employee' ? ['Self assessment'] : ['Manager assessment', 'Review meeting']) {
    await page.locator(`form[aria-label="${form}"]`).evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  }
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(1);
});

for (const audience of ['employee', 'manager']) test(`AM-04 browser ${audience} out-of-order Reload only adopts the newest revision`, async ({ page }) => {
  await page.goto(`${origin}/?audience=${audience}`);
  const name = audience === 'employee' ? 'self-0' : 'manager-0';
  const label = audience === 'employee' ? 'Save self draft' : 'Save manager draft';
  await field(page, name).fill('Browser draft before overlapping reads');
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  await page.evaluate(() => {
    const fixture = window.performanceReviewFixture, invoke = fixture.invoke.bind(fixture);
    window.am04Reads = [];
    fixture.invoke = (name, args) => {
      if (name !== 'loadPerformanceReviews') return invoke(name, args);
      fixture.calls.push({ name, args });
      return new Promise(resolve => window.am04Reads.push(resolve));
    };
  });
  const reload = page.getByRole('button', { name: 'Reload', exact: true });
  await reload.click(); await page.waitForFunction(() => window.am04Reads.length === 1);
  await reload.click(); await page.waitForFunction(() => window.am04Reads.length === 2);
  await field(page, name).fill('Browser newest draft during reads');
  const latest = review(audience, 'MAM', { dueDate: '2026-12-02', ...(audience === 'employee' ? { selfRevision: 'self:8' } : { managerRevision: 'manager:0:8' }) });
  await page.evaluate(result => window.am04Reads[1](result), { ok: true, data: workspace(audience, 'MAM', { reviews: [latest] }) });
  await expect(page.getByText(`2026 · 2026-12-02 · ${audience === 'employee' ? 'Awaiting employee' : 'Manager review'}`, { exact: true })).toBeVisible();
  await page.evaluate(result => window.am04Reads[0](result), { ok: true, data: workspace(audience) });
  await expect(field(page, name)).toHaveValue('Browser newest draft during reads');
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(1);
  await page.evaluate(() => window.performanceReviewFixture.holdNext('mutatePerformanceReview'));
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForFunction(() => window.performanceReviewFixture.pending().some(item => item.name === 'mutatePerformanceReview'));
  const second = (await calls(page, 'mutatePerformanceReview'))[1].args[0];
  expect(second.expectedRevision).toBe(audience === 'employee' ? 'self:8' : 'manager:0:8');
  expect(second.input.answers[0]).toBe('Browser newest draft during reads');
  await page.evaluate(result => window.performanceReviewFixture.release('mutatePerformanceReview', result), failure('conflict'));
});

for (const audience of ['employee', 'manager']) test(`AM-04 browser ${audience} unknown attempt after conflict stays reconciliation-only`, async ({ page }) => {
  await page.goto(`${origin}/?audience=${audience}`);
  const name = audience === 'employee' ? 'self-0' : 'manager-0';
  const label = audience === 'employee' ? 'Save self draft' : 'Save manager draft';
  await field(page, name).fill('Browser held unknown draft');
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  await enqueue(page, 'mutatePerformanceReview', failure('conflict', true));
  await page.getByRole('button', { name: label, exact: true }).click();
  const reconcile = page.getByRole('button', { name: 'Reconcile update', exact: true });
  await expect(reconcile).toBeVisible();
  const fresh = review(audience, 'MAM', audience === 'employee' ? { selfRevision: 'self:9' } : { managerRevision: 'manager:0:9' });
  await enqueue(page, 'loadPerformanceReviews', { ok: true, data: workspace(audience, 'MAM', { reviews: [fresh] }) });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(field(page, name)).toHaveValue('Browser held unknown draft');
  await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  await enqueue(page, 'reconcilePerformanceReviewOperation', { ok: true, data: { status: 'not_found', review: null } });
  await reconcile.click(); await expect(page.getByRole('alert')).toHaveText('The update is still unconfirmed.');
  await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(2);
  const pending = (await calls(page, 'mutatePerformanceReview'))[1].args[0];
  expect((await calls(page, 'reconcilePerformanceReviewOperation'))[0].args[0]).toEqual({ operationId: pending.operationId, reviewId: pending.reviewId });
});

test('AM-04 browser removed assignment clears the private conflict draft', async ({ page }) => {
  await page.goto(`${origin}/?audience=manager`);
  await field(page, 'managerNote').fill('PRIVATE-REVOKED-BROWSER-CONFLICT');
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: 'Save manager draft', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  await enqueue(page, 'loadPerformanceReviews', { ok: true, data: workspace('manager', 'MAM', { reviews: [], startablePeople: [] }) });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(field(page, 'managerNote')).toHaveCount(0);
  await expect(page.locator('form')).toHaveCount(0);
  expect(await page.locator('body').textContent()).not.toContain('PRIVATE-REVOKED-BROWSER-CONFLICT');
  expect(await calls(page, 'mutatePerformanceReview')).toHaveLength(1);
});

test('AM-04 browser review A to B to A retires the old conflict recovery', async ({ page }) => {
  await page.goto(`${origin}/?audience=manager`);
  await expect(field(page, 'managerNote')).toBeVisible();
  const a = review('manager'), b = review('manager', 'MAM', { id: '33000000-0000-4000-8000-000000000002', code: 'PR-2026-0002', employee: { ...a.employee, id: '22000000-0000-4000-8000-000000000099', name: 'Synthetic B colleague' } });
  const data = workspace('manager', 'MAM', { reviews: [a, b] });
  await enqueue(page, 'loadPerformanceReviews', { ok: true, data });
  await page.evaluate(actor => window.performanceReviewFixture.emitAuth('TOKEN_REFRESHED', actor), ids.actor);
  await expect(page.getByRole('button', { name: `${b.employee.name} — ${b.employee.company}`, exact: true })).toBeVisible();
  await field(page, 'managerNote').fill('PRIVATE-OLD-A-BROWSER-CONFLICT');
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: 'Save manager draft', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  await page.evaluate(() => window.performanceReviewFixture.holdNext('loadPerformanceReviews'));
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.waitForFunction(() => window.performanceReviewFixture.pending().some(item => item.name === 'loadPerformanceReviews'));
  for (const row of [b, a]) await page.getByRole('button', { name: `${row.employee.name} — ${row.employee.company}`, exact: true }).click();
  await field(page, 'managerNote').fill('New browser A draft');
  const newer = workspace('manager', 'MAM', { reviews: [{ ...a, managerRevision: 'manager:0:9' }, b] });
  await page.evaluate(result => window.performanceReviewFixture.release('loadPerformanceReviews', result), { ok: true, data: newer });
  await expect(field(page, 'managerNote')).toHaveValue('New browser A draft');
  await enqueue(page, 'loadPerformanceReviews', { ok: true, data: newer });
  await page.evaluate(actor => window.performanceReviewFixture.emitAuth('TOKEN_REFRESHED', actor), ids.actor);
  await enqueue(page, 'mutatePerformanceReview', failure('conflict'));
  await page.getByRole('button', { name: 'Save manager draft', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic conflict.');
  const second = (await calls(page, 'mutatePerformanceReview'))[1].args[0];
  expect(second.expectedRevision).toBe('manager:0:0');
  expect(second.input.managerNote).toBe('New browser A draft');
});
