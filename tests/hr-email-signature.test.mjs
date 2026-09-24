import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildCheckInReminderWorkflow } from '../scripts/build-check-in-reminder-workflow.mjs';
import { buildNewStarterDayOneWorkflow } from '../scripts/build-new-starter-day-one-workflow.mjs';
import { HR_EMAIL_SIGNATURE_HTML } from '../scripts/hr-email-signature.mjs';

const checkInBuilders = [
  'Build 2-Week Email and Attachment',
  'Build 1-Month Email and Attachment',
  'Build 2-Month Stay Interview Email and Attachment',
  'Build 3-Month Midpoint Review Email and Attachment',
  'Build 5-Month No-Surprises Review Email and Attachment',
  'Build 6-Month Check-In Email and Attachment',
  'Build 6-Month Casual Check-In Email and Attachment',
  'Build People & Culture Review Email',
];

const input = {
  employeeFirstName: 'Taylor',
  employeeName: 'Taylor Starter',
  managerFirstName: 'Morgan',
  managerName: 'Morgan Manager',
  role: 'Coordinator',
  milestone: '6-month-casual',
  reviewDate: '2027-03-01',
  notes: 'Follow up',
};

test('every HR onboarding and Check-In template uses one fixed MAM signature', () => {
  const workflows = [buildNewStarterDayOneWorkflow({ mode: 'test' }), buildCheckInReminderWorkflow({ mode: 'test' })];
  const names = ['Build Day 1 Email and Attachment', ...checkInBuilders];
  for (const name of names) {
    const node = workflows.flatMap((workflow) => workflow.nodes).find((item) => item.name === name);
    assert.ok(node, name);
    const milestone = name.includes('5-Month') ? '5-month' : name.includes('6-Month Casual') ? '6-month-casual' : name.includes('6-Month') ? '6-month' : input.milestone;
    const result = new Function('$input', node.parameters.jsCode)({ first: () => ({ json: { ...input, milestone } }) })[0];
    assert.equal(result.json.bodyContent.split(HR_EMAIL_SIGNATURE_HTML).length, 2, name);
    assert.match(result.json.bodyContent, /<p>Thanks,<br>(HR Manager|People Hub)<\/p>/);
  }
});

test('signature logo is a real bundled image with a readable text fallback', () => {
  assert.equal(readFileSync(new URL('../public/email/mam-logo.jpg', import.meta.url)).subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.match(HR_EMAIL_SIGNATURE_HTML, /alt="MAM – Mobility Access Modifications"/);
  assert.match(HR_EMAIL_SIGNATURE_HTML, /mailto:hr@mobilityaccess\.com\.au/);
});
