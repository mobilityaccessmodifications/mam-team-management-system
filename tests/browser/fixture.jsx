import "@/app/globals.css";
import { PayrollCarryforwardFixture } from "./payroll-carryforward-fixture";
import { DirectoryFixture } from "./directory-fixture";
import { TeamDirectoryFixture } from "./team-directory-fixture";
import { OrganisationFixture } from "./organisation-fixture";
import { EmployeePickerFixture } from "./employee-picker-fixture";
import { OnboardingReviewFixture } from "./onboarding-review-fixture";
import { createRoot } from "react-dom/client";
import { fixtureBuildEvents, FixtureEventDetail, TeamCalendar } from "@/components/team-calendar";

const partial = new URLSearchParams(location.search).has("partial");
const events = fixtureBuildEvents([], [], [{
  id: "synthetic", employee: "Synthetic Employee (archived)", initials: "SE", team: "Synthetic team", leaveType: "Approved leave",
  startDate: "2026-09-24", endDate: partial ? "2026-09-24" : "2026-09-28",
  startTime: partial ? "09:00" : undefined, endTime: partial ? "12:00" : undefined,
  days: partial ? 1 : 3, hours: partial ? 3 : 22.8, status: "Approved",
}], [], [], [2026]);
const today = new Date();
const calendarDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const spanning = new URLSearchParams(location.search).has("calendar-span");
const nextDay = new Date(today);
nextDay.setDate(nextDay.getDate() + 1);
const calendarEnd = spanning ? `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, "0")}-${String(nextDay.getDate()).padStart(2, "0")}` : calendarDate;
const firstFriday = 1 + (5 - new Date(today.getFullYear(), today.getMonth(), 1).getDay() + 7) % 7;
const crowdedDate = `${calendarDate.slice(0, 8)}${String(firstFriday).padStart(2, "0")}`;
const staffRequests = [
  { id: "11111111-1111-4111-8111-111111111111", employee: "Sample Staff", initials: "SS", team: "Minor", leaveType: "Sick leave", startDate: calendarDate, endDate: calendarEnd, days: spanning ? 2 : 1, status: "Approved", requestedAt: "2026-09-01T12:00:00Z", approvedBy: "Sample Reviewer", documentCount: 1 },
  { id: "22222222-2222-4222-8222-222222222222", employee: "Other Staff", initials: "OS", team: "Major", leaveType: "Annual leave", startDate: calendarDate, endDate: calendarDate, days: 1, status: "Pending", requestedAt: "2026-09-02T12:00:00Z", documentCount: 0 },
];
const crowdedRequests = new URLSearchParams(location.search).has("crowded")
  ? Array.from({ length: 12 }, (_, index) => ({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    employee: `Fixture Staff ${index}`, initials: "FS", team: "Minor", leaveType: "Annual leave",
    startDate: crowdedDate, endDate: crowdedDate, days: 1, status: "Pending",
  }))
  : [];
createRoot(document.getElementById("root")).render(
  new URLSearchParams(location.search).get("fixture") === "onboarding-review" ? <OnboardingReviewFixture /> :
  new URLSearchParams(location.search).get("fixture") === "payroll-carryforward" ? <PayrollCarryforwardFixture /> : new URLSearchParams(location.search).get("fixture") === "directory" ? <DirectoryFixture /> : new URLSearchParams(location.search).get("fixture") === "organisation" ? <OrganisationFixture /> : new URLSearchParams(location.search).get("fixture") === "team-directory" ? <TeamDirectoryFixture /> : new URLSearchParams(location.search).get("fixture") === "employee-picker" ? <EmployeePickerFixture /> : new URLSearchParams(location.search).get("fixture") === "staff-calendar" ? <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><TeamCalendar
    birthdays={[]} checkIns={[]} requests={[...staffRequests, ...crowdedRequests]} attachments={[{ id: "33333333-3333-4333-8333-333333333333", leaveRequestId: staffRequests[0].id, fileName: "sample.pdf" }]}
    subscriptionReviews={[]} payrollBalanceReminders={[]} showSubscriptionReviews={false} showPayrollBalanceReminders={false} reviewOnly={false} loading={false}
  /></div> : new URLSearchParams(location.search).get("fixture") === "employee-calendar" ? <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><TeamCalendar
    birthdays={[]} checkIns={[]} requests={[{ ...staffRequests[0], employee: "Other Staff", leaveType: "Approved leave", requestedAt: undefined, approvedBy: undefined, documentCount: undefined }]}
    attachments={[]} subscriptionReviews={[]} payrollBalanceReminders={[]} showSubscriptionReviews={false} showPayrollBalanceReminders={false} reviewOnly={false} loading={false}
  /></div> : <FixtureEventDetail event={events.find((event) => event.id === "leave:synthetic")} onClose={() => {}} />,
);
