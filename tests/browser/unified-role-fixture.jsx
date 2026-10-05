import { createRoot } from 'react-dom/client';
import { LeaveDemo } from '@/components/leave-demo';
import { actorCapabilities } from './unified-role-boundary.mjs';

createRoot(document.getElementById('root')).render(<LeaveDemo
  actorCapabilities={actorCapabilities} isNonRosterSystemAdmin={true} canViewTeamCalendar={true}
  checkInResources={{ managerGuideUrl: null, checkInFormUrl: null, probationTemplatesUrl: null, legacyFormsFolderUrl: null, deliveryConfigured: false, canApproveEmploymentDecisions: true }}
/>);
