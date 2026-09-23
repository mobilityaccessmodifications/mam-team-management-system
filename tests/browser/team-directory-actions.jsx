let attempts = 0;
export async function listEmployeeTeamDirectory(previewPersonId) {
  if (new URLSearchParams(location.search).has("fail") && attempts++ === 0) throw new Error("Synthetic failure");
  const id = previewPersonId ?? "self";
  return [
    { id, name: id === "other" ? "Other Employee" : "Alex Employee", position: "Coordinator", company: "mam", reportsTo: "manager-a", managerName: "Morgan Manager" },
    { id: id + "-peer", name: id === "other" ? "Other Peer" : "Blair Peer", position: "Analyst", company: "mam", reportsTo: "manager-b", managerName: "Jordan Manager" },
  ];
}
