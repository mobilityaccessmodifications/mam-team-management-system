import { useState } from "react";
import { EmployeePicker } from "@/components/employee-picker";

const people = [
  { personId: "person-a", fullName: "Alex Example", positionTitle: "Team leader", teamName: "Minor", company: "mam" },
  { personId: "person-b", fullName: "Blair Example", positionTitle: "Manager", teamName: "Warehouse", company: "mam" },
];

export function EmployeePickerFixture() {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState("");
  const optional = new URLSearchParams(location.search).has("optional");
  return <form onSubmit={(event) => { event.preventDefault(); setSubmitted(new FormData(event.currentTarget).get("managerId") || "none"); }}>
    <EmployeePicker assignees={people} value={value} onValueChange={setValue} name="managerId" ariaLabel="Reports to" required={!optional} placeholder="No manager assigned" />
    <button type="submit">Save</button>
    <button type="button" onClick={() => setValue("person-b")}>Load another record</button>
    <output aria-label="Saved manager">{submitted}</output>
  </form>;
}
