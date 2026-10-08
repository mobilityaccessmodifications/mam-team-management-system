import '@/app/globals.css';
import { createRoot } from 'react-dom/client';
import { LeaveDemo } from '@/components/leave-demo';
import { actorCapabilities } from './unified-role-boundary.mjs';

createRoot(document.getElementById('root')).render(<LeaveDemo
  initialNavigation={new URLSearchParams(location.search).has('leave-completed') ? {
    view: 'leave', section: 'requests', requestId: new URLSearchParams(location.search).get('request') ?? undefined,
  } : undefined}
  actorCapabilities={actorCapabilities} isNonRosterSystemAdmin={true} canViewTeamCalendar={true}
  checkInResources={{ managerGuideUrl: null, checkInFormUrl: null, probationTemplatesUrl: null, legacyFormsFolderUrl: null, deliveryConfigured: false, canApproveEmploymentDecisions: true }}
/>);
