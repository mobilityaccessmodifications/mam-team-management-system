import { createRoot } from 'react-dom/client';
import { useState, useEffect } from 'react';
import { LeaveDemo } from '@/components/leave-demo';
import { SelfProfileMenu } from '@/components/self-profile-menu';
import { invokeServerAction } from './contact-lifetime-boundary.mjs';
function NativeHost() {
  const [profile, setProfile] = useState(Object.values(CONTACT_FIXTURE_RESULTS)[0]);
  useEffect(() => {
    window.contactFixture.replaceDTO = () => setProfile(p => ({ ...p, phone: 'late authoritative DTO' }));
    return () => { delete window.contactFixture.replaceDTO; };
  }, []);
  return <SelfProfileMenu profile={profile} scopeKey="self:0" onSave={async (changes, isCurrent) => {
    const updated = await invokeServerAction('@/app/profile/actions', 'updateCurrentEmployeeSelfProfile', [{ ...changes, detailVersion: profile.detailVersion }]);
    if (!isCurrent || isCurrent()) setProfile(updated);
    return { message: 'Your contact details are saved.' };
  }} />;
}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('native') ? <NativeHost /> : <LeaveDemo
  actorCapabilities={CONTACT_ROLE_RESULTS.self.capabilities}
  isAdmin={true} isNonRosterSystemAdmin={true} canViewEmployeeDirectory={true}
  canChangeEmployeeView={true} canViewTeamCalendar={true}
/>);
