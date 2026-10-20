import { createRoot } from 'react-dom/client';
import PerformanceReviewWorkspace from '@/components/performance-review-workspace';
import { workspace, documentFor } from '../performance-review-fixtures.mjs';
import '@/app/globals.css';

const params = new URLSearchParams(location.search);
const audience = params.get('audience') ?? 'employee';
const company = params.get('company') ?? 'MAM';
if (!['employee','manager','admin'].includes(audience) || !['MAM','Equipsy'].includes(company)) throw new Error('Unknown synthetic fixture.');
const initial = workspace(audience, company);
if (audience === 'manager') initial.startablePeople = [initial.reviews[0].employee];
const queues = new Map(), holds = new Set(), pending = [];
const fixture = {
  workspace: initial, calls: [], unexpected: [], authListeners: new Set(),
  enqueue(name, result) { const queue = queues.get(name) ?? []; queue.push(result); queues.set(name, queue); },
  holdNext(name) { holds.add(name); },
  pending() { return pending.map(item => ({ name: item.name, args: item.args })); },
  release(name, result, reject = false) {
    const index = pending.findIndex(item => item.name === name);
    if (index < 0) throw new Error('No held boundary for '+name);
    const [item] = pending.splice(index, 1);
    if (reject) item.reject(new Error('Synthetic transport failure')); else item.resolve(result);
  },
  async invoke(name, args) {
    fixture.calls.push({ name, args: structuredClone(args) });
    if (holds.delete(name)) return new Promise((resolve, reject) => pending.push({ name, args: structuredClone(args), resolve, reject }));
    const queue = queues.get(name);
    if (queue?.length) return structuredClone(queue.shift());
    if (name === 'loadPerformanceReviewMeetingInvitationStatus') return { ok: true, reviewId: args[0], sent: false };
    if (name === 'loadPerformanceReviews') return { ok: true, data: structuredClone(fixture.workspace) };
    if (name === 'getPerformanceReviewDocument') {
      const row = fixture.workspace.reviews.find(item => item.id === args[0]);
      if (row) return { ok: true, document: documentFor(row) };
    }
    fixture.unexpected.push(name); throw new Error('Unexpected synthetic boundary: '+name);
  },
  emitAuth(event, actorUserId = null) { for (const listener of fixture.authListeners) listener(event, actorUserId ? { user: { id: actorUserId } } : null); },
};
window.performanceReviewFixture = fixture;
const root = createRoot(document.getElementById('root'));
fixture.unmount = () => root.unmount();
root.render(<PerformanceReviewWorkspace />);
