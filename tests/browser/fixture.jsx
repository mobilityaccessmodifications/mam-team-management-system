import { createRoot } from "react-dom/client";
import { fixtureBuildEvents, FixtureEventDetail } from "@/components/team-calendar";

const partial = new URLSearchParams(location.search).has("partial");
const events = fixtureBuildEvents([], [], [{
  id: "synthetic", employee: "Synthetic Employee (archived)", initials: "SE", team: "Synthetic team", leaveType: "Approved leave",
  startDate: "2026-09-24", endDate: partial ? "2026-09-24" : "2026-09-28",
  startTime: partial ? "09:00" : undefined, endTime: partial ? "12:00" : undefined,
  days: partial ? 1 : 3, hours: partial ? 3 : 22.8, status: "Approved",
}], [], [], [2026]);
createRoot(document.getElementById("root")).render(
  <FixtureEventDetail event={events.find((event) => event.id === "leave:synthetic")} onClose={() => {}} />,
);
