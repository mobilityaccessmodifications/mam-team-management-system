import { useState } from "react";
import { OrganisationTree } from "@/components/organisation-tree";

const initial = [
  { id: "director", name: "Director Example", position: "Director", company: "mam", reportsTo: null, version: 1 },
  { id: "manager", name: "Manager Example", position: "Team Leader", company: "mam", reportsTo: "director", version: 2 },
  { id: "starter", name: "Starter Example", position: "Installer", company: "mam", reportsTo: null, version: 3 },
];
window.organisationCalls = [];
export function OrganisationFixture() {
  const [profiles, setProfiles] = useState(initial);
  const outcome = new URLSearchParams(location.search).get("outcome") ?? "lock";
  return <main style={{ height: "100dvh", "--surface": "#fff", "--ink": "#14211b", "--mam": "#ee6b23", "--line": "#d7dfda", "--ease-out": "ease-out" }}>
    <OrganisationTree profiles={profiles} canEdit canArrange onUpdate={async (id, draft) => {
      window.organisationCalls.push({ id, draft });
      if (outcome === "lock") throw new Error("Onboarding credential delivery in progress");
      if (outcome === "other") throw new Error("This org node changed since it was opened. Refresh and try again.");
      setProfiles(current => current.map(person => person.id === id ? { ...person, reportsTo: draft.reportsTo, version: person.version + 1 } : person));
    }} />
  </main>;
}
