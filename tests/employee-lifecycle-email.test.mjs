import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICABILITY_NOTE, buildEmployeeLifecycleEmail } from '../scripts/employee-lifecycle-email.mjs';

const employee = { name: 'Sample Employee', company: 'MAM', role: 'Sample role', startDate: '2026-11-02', endDate: '2026-10-22' };

test('both checklists put applicability before employee details and preserve separate dates', () => {
  for (const kind of ['onboarding', 'offboarding']) {
    const email = buildEmployeeLifecycleEmail({ kind, employee, preview: true });
    const body = email.html.slice(email.html.indexOf('<body'));
    assert.ok(body.indexOf(APPLICABILITY_NOTE) < body.indexOf('Sample Employee'));
    assert.match(email.html, /scope="col"/);
    assert.match(email.html, /future update/);
    assert.match(email.subject, /^\[PREVIEW\]/);
    assert.match(email.text, kind === 'onboarding' ? /Start date: 2 November 2026/ : /Final working day: 22 October 2026/);
    assert.doesNotMatch(email.html, /[?&]token=/);
  }
});

test('employee values cannot inject markup or subject headers', () => {
  const email = buildEmployeeLifecycleEmail({ kind: 'offboarding', employee: { ...employee, name: '<img src=x onerror=alert(1)>\r\nBcc: nowhere@example.invalid', role: '<script>alert(1)</script>' } });
  assert.doesNotMatch(email.html, /<script>|<img src=x/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.subject, /[\r\n]/);
  assert.doesNotMatch(email.html, /MARKETING PREVIEW/);
});

test('missing or invalid dates fail rather than invent an employee date', () => {
  for (const endDate of [undefined, '', '2026-02-30', '2026-13-01']) {
    assert.throws(() => buildEmployeeLifecycleEmail({ kind: 'offboarding', employee: { ...employee, endDate } }), /valid employee date/);
  }
  assert.throws(() => buildEmployeeLifecycleEmail({ kind: 'unknown', employee }), /Select onboarding/);
});
