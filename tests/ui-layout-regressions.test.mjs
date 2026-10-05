import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const peopleStyles = readFileSync("src/components/people-operations-demo.module.css", "utf8");
const peopleSource = readFileSync("src/components/people-operations-demo.tsx", "utf8");
const leaveSource = readFileSync("src/components/leave-demo.tsx", "utf8")
  + readFileSync("src/components/leave-request-dialog.tsx", "utf8");
const leaveStyles = readFileSync("src/components/leave-demo.module.css", "utf8");
const subscriptionStyles = readFileSync("src/components/subscription-register.module.css", "utf8");
const organisationStyles = readFileSync("src/components/organisation-tree.module.css", "utf8");
const calendarStyles = readFileSync("src/components/team-calendar.module.css", "utf8");
const loginSource = readFileSync("src/app/login/page.tsx", "utf8");
const globalStyles = readFileSync("src/app/globals.css", "utf8");
const motionTabStyles = readFileSync("src/components/ui/motion-tabs.module.css", "utf8");
const pageSource = readFileSync("src/app/page.tsx", "utf8");
const leaveActionsSource = readFileSync("src/app/leave/actions.ts", "utf8");

test("the redesigned shell uses a dark split workspace at desktop and a safe-area bottom bar on mobile", () => {
  assert.match(leaveSource, /className=\{styles\.navHeading\}>Workspace/);
  assert.match(leaveSource, /className=\{styles\.topbarHeading\}/);
  assert.doesNotMatch(leaveSource, /homeWelcome|Welcome back/);
  assert.match(leaveStyles, /Apple workspace v2/);
  assert.match(globalStyles, /--sidebar: #182421;/);
  assert.match(globalStyles, /--sidebar-raised: #22312d;/);
  assert.match(leaveStyles, /\.sidebar\s*\{[\s\S]*?var\(--sidebar\);/);
  assert.match(leaveStyles, /\.topbar\s*\{[\s\S]*?backdrop-filter: blur\(24px\) saturate\(130%\);/);

  const mobileStart = leaveStyles.lastIndexOf("@media (max-width: 900px)");
  const mobileRules = leaveStyles.slice(mobileStart);
  assert.ok(mobileStart >= 0);
  assert.match(mobileRules, /\.sidebar\s*\{[\s\S]*?position: fixed;[\s\S]*?env\(safe-area-inset-bottom\)/);
  assert.match(mobileRules, /\.nav\s*\{[\s\S]*?grid-template-columns: repeat\(var\(--nav-count, 4\), minmax\(0, 1fr\)\);/);

  const ownershipLayer = leaveStyles.slice(leaveStyles.lastIndexOf("Apple workspace v2"));
  assert.match(ownershipLayer, /\.viewPickerTrigger:hover\s*\{[^}]*background: #293a35;[^}]*color: #fff;/);
});

test("login has a distinct workspace story and focused Apple-style sign-in card", () => {
  assert.match(loginSource, /People work, made clear\./);
  assert.match(loginSource, /className="auth-story-content"/);
  assert.match(globalStyles, /\.auth-shell\s*\{[\s\S]*?grid-template-columns: minmax\(340px, \.92fr\) minmax\(440px, 1\.08fr\);/);
  assert.match(globalStyles, /\.auth-story-content\s*\{[\s\S]*?background:[\s\S]*?linear-gradient\(150deg, #1d302b, #10201c 72%\);/);
  assert.match(globalStyles, /\.auth-card\s*\{[\s\S]*?border-radius: 22px;[\s\S]*?background: rgb\(255 255 255 \/ 92%\);/);
  assert.match(globalStyles, /\.auth-story\s*\{[\s\S]*?min-width: 0;/);
  assert.match(globalStyles, /\.auth-form-wrap\s*\{[\s\S]*?min-width: 0;/);
  assert.match(globalStyles, /@media \(max-width: 1020px\)\s*\{[\s\S]*?\.auth-shell\s*\{[\s\S]*?grid-template-columns: 1fr;/);
});

test("compact People navigation stays on one horizontally scrollable row", () => {
  const start = peopleStyles.indexOf("@media (min-width: 721px) and (max-width: 1319px)");
  const end = peopleStyles.indexOf("@media (max-width: 720px)", start);
  const compactRules = peopleStyles.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(compactRules, /\.sectionSwitch\s*\{[\s\S]*?display: flex;[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/);
  assert.match(compactRules, /\.sectionSwitch > \[role="tab"\]\s*\{[\s\S]*?flex: 0 0 auto;[\s\S]*?min-width: max-content;/);
  assert.doesNotMatch(compactRules, /grid-template-columns:\s*repeat\(4/);
  assert.match(peopleSource, /<MotionTabs[\s\S]*?orientation="horizontal"/);

  const ownershipLayer = peopleStyles.slice(peopleStyles.lastIndexOf("Apple workspace v2"));
  assert.match(ownershipLayer, /\.peopleLayout\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(ownershipLayer, /\.sectionSwitch\s*\{[\s\S]*?display: flex;[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/);
});

test("leave balance is disclosed by the application flow, not the standing page", () => {
  assert.match(leaveSource, /formLeaveType === "Annual leave" \? <LeaveRequestBalance/);
  assert.doesNotMatch(leaveSource, /<RequestsView action=\{applyAction\}/);
  assert.doesNotMatch(leaveSource, /section === "approvals" \? applyAction/);
  assert.match(leaveStyles, /\.leaveHeader\s*\{[^}]*flex-wrap: nowrap;/);
  assert.match(leaveStyles, /\.leaveHeader > \.applyForLeaveButton\s*\{[^}]*margin-left: auto;/);
  assert.match(leaveSource, /className=\{styles\.applyCompactLabel\}>Apply<\/span>/);
  assert.match(leaveStyles, /\.leaveHeader > \.applyForLeaveButton \.applyCompactLabel\s*\{[^}]*display: inline;[^}]*position: static;[^}]*clip: auto;/);
});

test("team leave selection lives inside the request sheet and stays capability scoped", () => {
  assert.doesNotMatch(leaveSource, /LeaveSelfServiceControls|Request for team/);
  assert.match(leaveSource, /teamRequestPeople = leavePriority\?\.people\.filter\(\(person\) => person\.canSubmit\)/);
  assert.match(leaveSource, /className=\{styles\.requestPersonPicker\}/);
  assert.match(leaveSource, /aria-label="Request leave for"/);
  assert.match(leaveSource, /<option value="">Myself<\/option>/);
  assert.match(leaveStyles, /\.requestPersonPicker\s*\{[\s\S]*?min-height: 42px;/);
});

test("choosing a leave start date immediately aligns the end date", () => {
  assert.match(leaveSource, /const \[formStartDate, setFormStartDate\] = useState\(\(\) => nextAvailableLeaveDate\(\)\)/);
  assert.match(leaveSource, /setFormStartDate\(initialDate\);\s*setFormEndDate\(initialDate\);/);
  assert.match(leaveSource, /name="startDate"[\s\S]*?value=\{formStartDate\}[\s\S]*?setFormStartDate\(nextDate\); setFormEndDate\(nextDate\);/);
  assert.match(leaveSource, /name="endDate"[\s\S]*?min=\{formStartDate\}[\s\S]*?value=\{formEndDate\}/);
});

test("People selection and Organisation tool groups use clean, balanced affordances", () => {
  assert.match(motionTabStyles, /\.indicator::after\s*\{[^}]*display: none;[^}]*content: none;/);
  assert.match(organisationStyles, /\.chartControlGroup\s*\{[\s\S]*?border: 1px solid var\(--surface-border\);/);
  assert.match(organisationStyles, /\.chartControlGroup > :not\(:first-child\)\s*\{[^}]*border-left: 1px solid var\(--surface-border\);/);
  assert.match(organisationStyles, /\.filterButton\s*\{[\s\S]*?place-items: center;/);
});

test("transient feedback keeps an explicit high-contrast inverse surface", () => {
  assert.match(globalStyles, /--surface-inverse: #1d2d29;/);
  assert.match(globalStyles, /--text-on-inverse: #ffffff;/);
  assert.match(organisationStyles, /background: var\(--surface-inverse, #1d2d29\);[\s\S]*?color: var\(--text-on-inverse, #fff\);/);
  assert.match(peopleStyles, /\.toast\s*\{[^}]*background: var\(--surface-inverse, #1d2d29\);[^}]*color: var\(--text-on-inverse, #fff\);/);
});

test("calendar polish owns the final cascade after its full-viewport layout", () => {
  const ownershipStart = calendarStyles.lastIndexOf("Apple workspace v2: final ownership layer");
  assert.ok(ownershipStart > calendarStyles.lastIndexOf("Fill the calendar workspace"));
  const ownershipRules = calendarStyles.slice(ownershipStart);
  assert.match(ownershipRules, /\.df-header\) \{ min-height: 72px;[\s\S]*?backdrop-filter: blur\(20px\)/);
  assert.match(ownershipRules, /prefers-reduced-transparency: reduce/);
});

test("Calendar remains available to every active employee and trusts server-scoped event projections", () => {
  assert.match(pageSource, /canViewTeamCalendar=\{Boolean\(actor.person_id\) \|\| actor.is_super_admin\}/);
  assert.match(leaveSource, /canViewTeamCalendarForActiveProfile = canViewTeamCalendar;/);
  assert.match(leaveActionsSource, /supabase\.rpc\("list_leave_calendar_entries_with_teams"\)/);
  assert.match(leaveActionsSource, /supabase\.rpc\("list_employee_check_in_calendar_entries"\)/);
  assert.match(leaveActionsSource, /supabase\.rpc\("list_calendar_birthdays"\)/);
  assert.match(leaveActionsSource, /supabase\.rpc\("list_calendar_birthdays_for_preview", \{ p_person_id: checkedPreviewPersonId \}\)/);
  assert.doesNotMatch(leaveActionsSource, /canViewTeamCalendarScope/);
});

test("subscription column headings remain complete and use horizontal overflow", () => {
  assert.match(subscriptionStyles, /\.sheetViewport\s*\{[\s\S]*?overflow: auto;/);
  assert.match(subscriptionStyles, /--subscription-sheet-columns:[^;]*minmax\(166px,[^;]*minmax\(180px,[^;]*minmax\(184px,/);
  assert.match(subscriptionStyles, /\.sheetHeaderCell > span:first-child\s*\{[^}]*flex: 0 0 auto;[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(subscriptionStyles, /\.sheetHeaderCell > span:first-child\s*\{[^}]*text-overflow: ellipsis;/);
});
