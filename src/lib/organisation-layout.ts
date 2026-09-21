import type { OrganisationPerson } from "@/components/organisation-tree";

export type OrganisationLayout = "default" | "horizontal" | "vertical" | "grouped";
export type OrganisationLayoutNode = OrganisationPerson & { children: OrganisationLayoutNode[] };

export function isMinorModsLeader(node: OrganisationPerson) {
  return node.company === "mam" && /minor.*(?:mod|team|lead)/i.test(`${node.position} ${node.name}`)
    && node.kind !== "org_unit";
}

export function defaultBranchLayout(node: OrganisationPerson): Exclude<OrganisationLayout, "default"> {
  if (node.company === "equipsy") return "vertical";
  if (/^ste(?:ve|ven) makris$/i.test(node.name.trim())) return "horizontal";
  return "grouped";
}

export function minorRoleGroup(position: string) {
  if (/schedul/i.test(position)) return "0-scheduling";
  if (/install|trade/i.test(position)) return "1-installers";
  if (/estimat/i.test(position)) return "2-estimating";
  if (/admin/i.test(position)) return "3-administration";
  return `4-${position.trim().toLowerCase()}`;
}

/** Compact presentation only. The source records and reportsTo IDs stay intact. */
export function defaultDisplayChildren(node: OrganisationLayoutNode) {
  if (!isMinorModsLeader(node)) return node.children;
  const people: OrganisationLayoutNode[] = [];
  const collect = (children: OrganisationLayoutNode[]) => {
    for (const child of children) {
      // Group the whole team by role even when the stored tree contains
      // intermediate people or structural teams. Never mutate reportsTo.
      if (child.kind !== "org_unit") people.push({ ...child, children: [] });
      collect(child.children);
    }
  };
  collect(node.children);
  return people.sort((left, right) => minorRoleGroup(left.position).localeCompare(minorRoleGroup(right.position)));
}
