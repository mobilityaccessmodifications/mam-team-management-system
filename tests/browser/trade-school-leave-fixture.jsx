import { useState } from "react";
import { LeaveRequestDialog } from "@/components/leave-request-dialog";

const learnerId = "97000000-0000-4000-8000-000000000001";
const otherId = "97000000-0000-4000-8000-000000000002";
const people = [
  { personId: learnerId, name: "Synthetic learner", canSubmit: true, paidLeave: true, tradeSchoolEligible: true, canViewBalance: false, hours: null, asOf: null, isExample: false },
  { personId: otherId, name: "Synthetic colleague", canSubmit: true, paidLeave: true, tradeSchoolEligible: false, canViewBalance: false, hours: null, asOf: null, isExample: false },
];

export function TradeSchoolLeaveFixture() {
  const self = new URLSearchParams(location.search).has("self");
  const [personId, setPersonId] = useState(self ? "" : learnerId);
  const [leaveType, setLeaveType] = useState("trade school");
  const [startDate, setStartDate] = useState("2026-10-12");
  const [endDate, setEndDate] = useState("2026-10-12");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const selected = people.find((person) => person.personId === personId) ?? people[0];
  return <>
    <LeaveRequestDialog
      leaveRequestPersonInitials="SL" leaveRequestPersonName={selected.name}
      requestForPersonId={personId} onBehalfOf={Boolean(personId)}
      activeProfile={{ id: learnerId, team: "Synthetic team" }} teamRequestPeople={people}
      isMutating={false} canApplyForLeave={true} leavePriority={{ people, requests: [], pendingBalanceCalendarIds: [], canManageBalances: false }}
      formLeaveType={leaveType} availableLeaveTypes={[{ value: "Unpaid leave", label: "Unpaid leave" }, { value: "trade school", label: "trade school" }]}
      hasPaidLeaveEntitlement={true} employmentType="full_time"
      formStartDate={startDate} formEndDate={endDate} formError={error}
      closeLeaveRequestForm={() => {}}
      changeLeaveRequestPerson={(id) => { setPersonId(id); setLeaveType(id === otherId ? "Unpaid leave" : "trade school"); setError(""); }}
      submitRequest={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); setSubmitted({ personId: personId || learnerId, leaveType: data.get("leaveType"), startDate: data.get("startDate") }); }}
      setFormError={setError} setFormLeaveType={setLeaveType} setFormStartDate={setStartDate} setFormEndDate={setEndDate}
    />
    <output data-testid="trade-school-submission">{submitted ? JSON.stringify(submitted) : "Not submitted"}</output>
  </>;
}
