import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICABILITY_NOTE, buildEmployeeLifecycleEmail } from '../scripts/employee-lifecycle-email.mjs';

const employee = { name: 'Sample Employee', company: 'MAM', role: 'Sample role', startDate: '2026-11-02', endDate: '2026-10-22' };

test('both checklists put applicability before employee details and preserve separate dates', () => {
  for (const kind of ['onboarding', 'offboarding']) {
    const email = buildEmployeeLifecycleEmail({ kind, employee, preview: true });
    const body = email.html.slice(email.html.indexOf('<body'));
    assert.ok(body.indexOf(APPLICABILITY_NOTE) < body.indexOf('Sample Employee'));
    assert.match(email.html, /scope="row"/);
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

test('emails group general, accounts and IT and use recorded location, schedule and prestart deadline', () => {
  const example = {...employee, department:'Minor', location:'hq', employmentType:'full_time', personalEmail:'test@example.invalid',
    timesheetEntries:'deputy_hubstaff', workingWeekdays:[1,3,5], workingDayTimes:[{weekday:1,start_time:'08:00',end_time:'16:00'}],
    teamLeader:'Serene Sharma', laptopCode:'LAP-101', prestartDeadline:'2026-10-30'};
  const onboarding=buildEmployeeLifecycleEmail({kind:'onboarding',employee:example});
  for(const section of ['General employee information','Accounts','IT']) assert.match(onboarding.html,new RegExp(section));
  for(const expected of ['HQ','Deputy &amp; Hubstaff','Monday, Wednesday, Friday','Monday 08:00–16:00','30 October 2026',
    'Serene Sharma','LAP-101','OneDrive needed','SharePoint folders requiring access','Team Leader to confirm']) assert.ok(onboarding.html.includes(expected),expected);
  assert.doesNotMatch(onboarding.html,/Power BI \/ Reporting Owner|HR – Maricon/);
  assert.match(onboarding.html,/Contact the employee via text\/email ahead of their first day/);
});
test('IT exclusion and absent work schedule are explicit', () => {
  for(const patch of [{location:'onsite_trade'},{department:'Warehouse'},{employmentType:'overseas'}]){
    const email=buildEmployeeLifecycleEmail({kind:'onboarding',employee:{...employee,...patch}});
    assert.match(email.html,/No IT access required/);
    assert.doesNotMatch(email.html,/OneDrive needed|Laptop code to configure/);
  }
  const unrecorded=buildEmployeeLifecycleEmail({kind:'onboarding',employee});
  assert.match(unrecorded.text,/Usual work days: No record in People Hub/);
  assert.match(unrecorded.text,/Start \/ finish times: No record in People Hub/);
});
test('offboarding uses final working day rather than prestart deadline',()=>{
  const email=buildEmployeeLifecycleEmail({kind:'offboarding',employee:{...employee,location:'hq',prestartDeadline:'2026-10-30'}});
  assert.match(email.text,/Deadline \(final working day\): 22 October 2026/);
  assert.doesNotMatch(email.text,/Deadline \(one Victorian business day before start\)/);
});
