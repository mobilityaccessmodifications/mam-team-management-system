import '@/app/globals.css';
import { createRoot } from 'react-dom/client';
import { LeaveDemo } from '@/components/leave-demo';
import { actorCapabilities } from './unified-role-boundary.mjs';
import { SubscriptionDelegationDialog } from '@/components/subscription-delegation-dialog';
import { useState } from 'react';
const ordinaryReviewEmployee = new URLSearchParams(location.search).get('subscription-reviews') === 'employee';

function DelegationFixture() {
  const [open, setOpen] = useState(true);
  return open ? <SubscriptionDelegationDialog onClose={() => setOpen(false)} onSaved={() => { window.delegationSaved = (window.delegationSaved ?? 0) + 1; }} /> : <button onClick={() => setOpen(true)}>Reopen delegation</button>;
}

createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('delegation') ? <DelegationFixture /> : <LeaveDemo
  initialNavigation={new URLSearchParams(location.search).has('leave-completed') ? {
    view: 'leave', section: 'requests', requestId: new URLSearchParams(location.search).get('request') ?? undefined,
  } : undefined}
  actorCapabilities={actorCapabilities} isNonRosterSystemAdmin={!ordinaryReviewEmployee} currentPersonId={ordinaryReviewEmployee ? '11000000-0000-4000-8000-000000000005' : undefined} canViewTeamCalendar={true}
  checkInResources={{ managerGuideUrl: null, checkInFormUrl: null, probationTemplatesUrl: null, legacyFormsFolderUrl: null, deliveryConfigured: false, canApproveEmploymentDecisions: true }}
/>);
