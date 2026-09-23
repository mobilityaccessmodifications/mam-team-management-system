import { useState } from "react";
import { EmployeeTeamDirectory } from "@/components/employee-team-directory";
export function TeamDirectoryFixture() {
  const [personId, setPersonId] = useState("self");
  return <><button onClick={() => setPersonId("other")}>Switch employee</button><EmployeeTeamDirectory key={personId} currentPersonId={personId} previewPersonId={personId === "other" ? personId : undefined} /></>;
}
