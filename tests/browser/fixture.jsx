import { TeamDirectoryFixture } from "./team-directory-fixture";
import { EmployeePickerFixture } from "./employee-picker-fixture";
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
const staffRequests = [
  { id: "11111111-1111-4111-8111-111111111111", employee: "Sample Staff", initials: "SS", team: "Minor", leaveType: "Sick leave", startDate: calendarDate, endDate: calendarDate, days: 1, status: "Approved", requestedAt: "2026-09-01T12:00:00Z", approvedBy: "Sample Reviewer", documentCount: 1 },
  { id: "22222222-2222-4222-8222-222222222222", employee: "Other Staff", initials: "OS", team: "Major", leaveType: "Annual leave", startDate: calendarDate, endDate: calendarDate, days: 1, status: "Pending", requestedAt: "2026-09-02T12:00:00Z", documentCount: 0 },
];
createRoot(document.getElementById("root")).render(
  new URLSearchParams(location.search).get("fixture") === "team-directory" ? <TeamDirectoryFixture /> : new URLSearchParams(location.search).get("fixture") === "employee-picker" ? <EmployeePickerFixture /> : new URLSearchParams(location.search).get("fixture") === "staff-calendar" ? <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><TeamCalendar
    birthdays={[]} checkIns={[]} requests={staffRequests} attachments={[{ id: "33333333-3333-4333-8333-333333333333", leaveRequestId: staffRequests[0].id, fileName: "sample.pdf" }]}
    subscriptionReviews={[]} payrollBalanceReminders={[]} showSubscriptionReviews={false} showPayrollBalanceReminders={false} reviewOnly={false} loading={false}
  /></div> : new URLSearchParams(location.search).get("fixture") === "employee-calendar" ? <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><TeamCalendar
    birthdays={[]} checkIns={[]} requests={[{ ...staffRequests[0], employee: "Other Staff", leaveType: "Approved leave", requestedAt: undefined, approvedBy: undefined, documentCount: undefined }]}
    attachments={[]} subscriptionReviews={[]} payrollBalanceReminders={[]} showSubscriptionReviews={false} showPayrollBalanceReminders={false} reviewOnly={false} loading={false}
  /></div> : <FixtureEventDetail event={events.find((event) => event.id === "leave:synthetic")} onClose={() => {}} />,
);
