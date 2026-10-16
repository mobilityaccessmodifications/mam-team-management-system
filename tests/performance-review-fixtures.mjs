export const ids = { actor: '11000000-0000-4000-8000-000000000001', person: '22000000-0000-4000-8000-000000000001', manager: '22000000-0000-4000-8000-000000000002', review: '33000000-0000-4000-8000-000000000001', other: '33000000-0000-4000-8000-000000000002' };
export const ratings = ['1 Needs improvement', '2 Meets expectations', '3 Exceeds expectations', 'N Not enough evidence'];
export function identity(company = 'MAM', id = ids.person) { return { id, name: 'Synthetic Colleague', jobTitle: 'Test specialist', company, team: 'Synthetic team' }; }
export function review(audience = 'employee', company = 'MAM', overrides = {}) {
  const self = { id: ids.review, code: 'PR-2026-0001', employee: identity(company), manager: { id: ids.manager, name: 'Synthetic Reviewer' }, cycle: '2026', dueDate: '2026-11-30', selfStatus: 'awaiting_employee', selfAnswers: Array.from({ length: 12 }, (_, i) => `Synthetic answer ${i + 1}`), selfSubmittedAt: null, selfRevision: 'self:0', selfActivity: [], audience, capabilities: { saveSelf: true, submitSelf: true, downloadDocument: true } };
  if (audience !== 'employee') Object.assign(self, { selfStatus: 'manager_review', selfSubmittedAt: '2026-10-01T00:00:00Z', managerAnswers: Array.from({ length: 12 }, (_, i) => `Synthetic feedback ${i + 1}`), ratings: Array(12).fill(ratings[1]), summary: 'Synthetic summary', overallRating: ratings[1], managerNote: 'PRIVATE-SYNTHETIC-MANAGER-NOTE', managerCompletedAt: null, meeting: null, meetingHeldAt: null, finalisedAt: null, managerActivity: [], ...(audience === 'manager' ? { managerRevision: 'manager:0:0' } : { readRevision: 'read:0:0' }), capabilities: { saveSelf: false, submitSelf: false, saveManager: audience === 'manager', completeManager: audience === 'manager', saveMeeting: audience === 'manager', submitReview: audience === 'manager', downloadDocument: true } });
  return { ...self, ...overrides };
}
export function workspace(audience = 'employee', company = 'MAM', overrides = {}) {
  return { viewerContext: { actorUserId: ids.actor, personId: audience === 'manager' ? ids.manager : audience === 'admin' ? null : ids.person, role: audience === 'admin' ? 'admin' : audience, displayName: 'Synthetic Viewer' }, reviews: [review(audience, company)], startablePeople: [], ...overrides };
}
export function documentFor(row) {
  const doc = { audience: row.audience, code: row.code, cycle: row.cycle, employee: row.employee, manager: row.manager, selfAnswers: [...row.selfAnswers] };
  if (row.audience !== 'employee') Object.assign(doc, { managerAnswers: [...row.managerAnswers], ratings: [...row.ratings], summary: row.summary, overallRating: row.overallRating, meeting: row.meeting });
  return doc;
}
export function failure(code = 'unavailable', uncertain = false) { return { ok: false, code, uncertain, message: `Synthetic ${code}.` }; }
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
