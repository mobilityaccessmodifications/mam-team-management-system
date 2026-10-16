import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, ok, PERSON, USER } from './uat-effects-fixtures.mjs';

const requestPayload = {
  formVersion: 2, kind: 'new_purchase', service: 'Synthetic tool', purpose: 'Synthetic purpose', company: 'mam',
  duration: 'ongoing', billing: 'monthly', currency: 'AUD', payment: 'non_card', intendedUsers: 'Synthetic team',
  monthlyCostCents: 100, annualCostCents: 1000, quoteCents: 100, audEstimateCents: 100,
};
const scenarios = [
  {
    name: 'leave submission', path: 'src/app/leave/actions.ts', rpc: 'submit_leave_request_once',
    invoke: actions => actions.submitLeaveRequest({ submissionKey: PERSON, leaveType: 'Annual leave', startDate: '2026-11-02', endDate: '2026-11-02' }),
    data: [{ id: PERSON, status: 'Pending', approval_required: true, assigned_reviewer_label: 'Synthetic manager' }],
    accepted: result => assert.equal(result.id, PERSON),
  },
  {
    name: 'subscription submission', path: 'src/app/subscription-requests/actions.ts', rpc: 'sr_mutate',
    invoke: actions => actions.mutateSubscriptionRequest({ id: PERSON, version: 1, operation: 'submit', payload: requestPayload }),
    data: { id: PERSON, version: 2, status: 'submitted', events: [], evidence: [], payload: requestPayload, canEdit: false, canDecide: false, canWithdraw: true },
    accepted: result => assert.equal(result.ok, true),
  },
];
for (const scenario of scenarios) {
  for (const uat of [true, false]) {
    test(`${uat ? 'UAT' : 'ordinary'} actual ${scenario.name} after callback ${uat ? 'is inert' : 'reaches its normal queue'}`, async () => {
      const mutations = [];
      const f = fixture({ uat, client: {
        auth: { getUser: async () => ok({ user: { id: USER } }) },
        rpc: async (name, args) => { assert.equal(name, scenario.rpc); mutations.push({ name, args }); return ok(scenario.data); },
      }, admin: { rpc: async (name) => { f.calls.push('claim:' + name); return ok([]); } }, ports: { after: () => undefined, revalidate: () => undefined } });
      try {
        const actions = await f.load(scenario.path);
        scenario.accepted(await scenario.invoke(actions));
        assert.equal(mutations.length, 1);
        assert.equal(f.callbacks.length, 1);
        f.calls.splice(0);
        await f.flush();
        f.observe(scenario.name + ' after ' + (uat ? 'UAT' : 'ordinary'), {});
        if (uat) f.assertZero(scenario.name + ' after');
        else {
          assert.equal(f.calls.filter(name => name === 'admin').length, 1);
          assert.equal(f.calls.filter(name => name.startsWith('claim:')).length, 1);
        }
      } finally { f.cleanup(); }
    });
  }
}
