"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  Download,
  Focus,
  ListFilter,
  GripVertical,
  Link2,
  Link2Off,
  LocateFixed,
  Mail,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Pencil,
  Plus,
  Rows3,
  Search,
  Undo2,
  UserPlus,
  WandSparkles,
  X,
} from "lucide-react";
import {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "@/components/organisation-tree.module.css";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";

export type OrganisationCompany = "mam" | "equipsy";

export type OrganisationPerson = {
  id: string;
  name: string;
  position: string;
  company: OrganisationCompany;
  reportsTo: string | null;
  kind?: "person" | "org_unit";
  sortOrder?: number;
  isActive?: boolean;
};

export type OrganisationPersonDraft = {
  name: string;
  position: string;
  company: OrganisationCompany;
  reportsTo: string | null;
  kind?: "person";
};

export type OrganisationTreeProps = {
  profiles: OrganisationPerson[];
  /** Enables local-only visual arranging without enabling record mutations. */
  canArrange?: boolean;
  canEdit?: boolean;
  onCreate?: (person: OrganisationPersonDraft) => Promise<void>;
  onUpdate?: (
    id: string,
    person: OrganisationPersonDraft,
  ) => Promise<void>;
  /** Opens the HR-only record editor without exposing private fields in the tree. */
  onOpenEmployeeRecord?: (personId: string) => void;
  /** Loads only the selected person's employee-visible work contact on demand. */
  onRequestWorkEmail?: (personId: string) => Promise<string | null>;
  className?: string;
};

type CompanyFilter = "all" | OrganisationCompany;
type OrganisationFilter = CompanyFilter | "major" | "minor" | "warehouse";
type TreeNode = OrganisationPerson & { children: TreeNode[] };
type EditorState =
  | { mode: "create" }
  | { mode: "update"; id: string }
  | null;
type LayoutMode = "leaf" | "horizontal" | "vertical" | "grouped";
type BranchLayout = Exclude<LayoutMode, "leaf">;
type MeasuredNode = {
  node: TreeNode;
  children: MeasuredNode[];
  groups: ChildGroup[];
  width: number;
  height: number;
  mode: LayoutMode;
  depth: number;
};
type ChildGroup = {
  key: string;
  children: MeasuredNode[];
  width: number;
  height: number;
};
type PositionedNode = {
  node: TreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  hasChildren: boolean;
  childrenLayout: BranchLayout | null;
  descendantCount: number;
};
type Connector = {
  id: string;
  fromId: string;
  toId: string;
  company: OrganisationCompany;
  path: string;
};
type NodeOffset = { x: number; y: number };
type DropIntent = "sibling" | "report-to-target" | "target-reports-to-dragged";
type DropTarget = { id: string; intent: DropIntent };
type LinkGuideState = {
  sourceId: string;
  pointer: NodeOffset;
};
type RelationshipHistoryEntry = {
  personId: string;
  previousReportsTo: string | null;
  nextReportsTo: string | null;
};
type NodeDragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: NodeOffset;
  startedWithManualOffset: boolean;
  node: PositionedNode;
  moved: boolean;
};
type ChartLayout = {
  nodes: PositionedNode[];
  connectors: Connector[];
  width: number;
  height: number;
};

const companyLabels: Record<OrganisationCompany, string> = {
  mam: "MAM",
  equipsy: "Equipsy",
};

const organisationFilterLabels: Record<OrganisationFilter, string> = {
  all: "All companies",
  mam: "MAM",
  equipsy: "Equipsy",
  major: "Major",
  minor: "Minor",
  warehouse: "Warehouse",
};

function escapeExportMarkup(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wrapExportText(value: string, maxCharacters: number) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ["-"];

  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && nextLine.length > maxCharacters) {
      lines.push(currentLine);
      currentLine = word;
      continue;
    }
    currentLine = nextLine;
  }
  if (currentLine) lines.push(currentLine);

  if (lines.length <= 2) return lines;
  return [lines[0], `${lines.slice(1).join(" ").slice(0, maxCharacters - 1)}…`];
}

function exportSvgText(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
) {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeExportMarkup(line)}</tspan>`,
    )
    .join("");
}

/**
 * The PDF window intentionally contains only the employee-visible tree data:
 * name, position and company. HR contact details and account information never
 * enter the exported document.
 */
function buildOrganisationPdfDocument(
  layout: ChartLayout,
  title: string,
  scope: string,
  personCount: number,
) {
  const connectorMarkup = layout.connectors
    .map(
      (connector) =>
        `<path d="${connector.path}" fill="none" stroke="${connector.company === "equipsy" ? "#38b6ff" : "#ff751f"}" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />`,
    )
    .join("");
  const nodeMarkup = layout.nodes
    .map((item) => {
      const companyColor = item.node.company === "equipsy" ? "#38b6ff" : "#ff751f";
      const roleLines = wrapExportText(
        item.node.position || companyLabels[item.node.company],
        29,
      );
      const nameLines = wrapExportText(item.node.name, 26);
      const roleY = roleLines.length === 1 ? 17 : 10;
      const nameY = nameLines.length === 1 ? 50 : 44;
      return `<g transform="translate(${item.x} ${item.y})">
        <rect width="${item.width}" height="${item.height}" fill="#fffdf5" rx="2" />
        <rect width="${item.width}" height="27" fill="${companyColor}" rx="2" />
        <text x="${item.width / 2}" y="${roleY}" fill="#ffffff" font-family="Arial, sans-serif" font-size="9" font-weight="700" letter-spacing="0.3" text-anchor="middle">${exportSvgText(roleLines, item.width / 2, roleY, 10)}</text>
        <text x="${item.width / 2}" y="${nameY}" fill="#252c31" font-family="Arial, sans-serif" font-size="11.5" font-weight="700" text-anchor="middle">${exportSvgText(nameLines, item.width / 2, nameY, 11)}</text>
        <rect width="${item.width}" height="${item.height}" fill="none" rx="2" stroke="${companyColor}" />
      </g>`;
    })
    .join("");
  const escapedTitle = escapeExportMarkup(title);
  const escapedScope = escapeExportMarkup(scope);
  const generatedOn = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date());

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>
      @page { size: A3 landscape; margin: 10mm; }
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #f3f6f5; color: #252c31; font-family: Arial, sans-serif; }
      .page { max-width: 1580px; margin: 0 auto; padding: 26px; }
      .controls { display: flex; justify-content: flex-end; margin-bottom: 16px; }
      .controls button { border: 1px solid #df5c0b; border-radius: 6px; background: #ff751f; color: #fff; cursor: pointer; font: 700 13px Arial, sans-serif; padding: 10px 14px; }
      .masthead { display: flex; align-items: end; justify-content: space-between; gap: 24px; border-bottom: 2px solid #252c31; padding-bottom: 14px; }
      .eyebrow { display: block; color: #718084; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1.2px; text-transform: uppercase; }
      h1 { margin: 5px 0 0; font-size: 28px; line-height: 1.05; }
      .meta { color: #657276; font-size: 11px; line-height: 1.55; text-align: right; }
      .legend { display: flex; justify-content: flex-end; gap: 10px; margin-top: 5px; color: #657276; font-size: 9px; }
      .legend span { display: inline-flex; align-items: center; gap: 4px; }
      .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: #ff751f; }
      .legend i[data-company="equipsy"] { background: #38b6ff; }
      .chart { overflow: hidden; margin-top: 18px; background: #fff; border: 1px solid #d8dfdd; }
      .chart svg { display: block; width: 100%; height: auto; }
      .footer { display: flex; justify-content: space-between; gap: 18px; margin-top: 12px; color: #657276; font-size: 9px; line-height: 1.4; }
      @media print {
        body { background: #fff; }
        .page { max-width: none; padding: 0; }
        .controls { display: none; }
        .chart { break-inside: avoid; border-color: #cfd8d5; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <div class="controls"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
      <header class="masthead">
        <div><span class="eyebrow">People Hub</span><h1>${escapedTitle}</h1></div>
        <div class="meta">${escapedScope}<br />${personCount} ${personCount === 1 ? "person" : "people"} · Generated ${escapeExportMarkup(generatedOn)}<div class="legend"><span><i aria-hidden="true"></i>MAM</span><span><i aria-hidden="true" data-company="equipsy"></i>Equipsy</span></div></div>
      </header>
      <section class="chart" aria-label="Organisation chart">
        <svg role="img" aria-label="${escapedTitle}" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg">
          ${connectorMarkup}
          ${nodeMarkup}
        </svg>
      </section>
      <footer class="footer"><span>Organisation information only: names, positions and company.</span><span>Private contacts and account details are not included.</span></footer>
    </main>
    <script>window.addEventListener("load", function () { window.setTimeout(function () { window.focus(); window.print(); }, 250); });</script>
  </body>
</html>`;
}

const CARD_WIDTH = 188;
const CARD_HEIGHT = 64;
const HORIZONTAL_GAP = 30;
const VERTICAL_GAP = 68;
const STACK_GAP = 13;
const STACK_BUS = 24;
const ROOT_GAP = 88;
const CANVAS_MARGIN = 54;
const DEFAULT_ZOOM = 0.92;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.35;
const DRAG_THRESHOLD = 5;
const GRID_SIZE = 24;
const DROP_SNAP_X = 64;
const DROP_SNAP_Y = 64;
const ARRANGE_DURATION = 260;
const MOBILE_CHART_QUERY = "(max-width: 900px)";

const emptyDraft: OrganisationPersonDraft = {
  name: "",
  position: "",
  company: "mam",
  reportsTo: null,
  kind: "person",
};

function isPerson(profile: OrganisationPerson) {
  return profile.kind !== "org_unit";
}

function normalise(value: string) {
  return value.trim().toLocaleLowerCase();
}

function isStevenMakris(node: TreeNode) {
  const name = normalise(node.name);
  return name === "steven makris" || name === "steve makris";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function safeWorkEmail(value: string | null) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function sortPeople<T extends OrganisationPerson>(profiles: T[]) {
  return [...profiles].sort((left, right) => {
    const order =
      (left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
    if (order) return order;
    const position = left.position.localeCompare(right.position);
    if (position) return position;
    return left.name.localeCompare(right.name);
  });
}

function getDescendantIds(
  id: string,
  profiles: OrganisationPerson[],
): Set<string> {
  const descendants = new Set<string>();
  const queue = [id];

  while (queue.length) {
    const parentId = queue.shift();
    for (const profile of profiles) {
      if (
        profile.reportsTo === parentId &&
        profile.id !== id &&
        !descendants.has(profile.id)
      ) {
        descendants.add(profile.id);
        queue.push(profile.id);
      }
    }
  }

  return descendants;
}

function addAncestorIds(
  ids: Set<string>,
  profileById: Map<string, OrganisationPerson>,
) {
  const result = new Set(ids);
  for (const id of ids) {
    let managerId = profileById.get(id)?.reportsTo;
    const seen = new Set<string>();
    while (managerId && !seen.has(managerId)) {
      seen.add(managerId);
      result.add(managerId);
      managerId = profileById.get(managerId)?.reportsTo;
    }
  }
  return result;
}

function buildForest(
  profiles: OrganisationPerson[],
  visibleIds: Set<string>,
): TreeNode[] {
  const visible = profiles.filter((profile) => visibleIds.has(profile.id));
  const visibleById = new Map(visible.map((profile) => [profile.id, profile]));
  const childrenByParent = new Map<string, OrganisationPerson[]>();

  for (const profile of visible) {
    if (
      profile.reportsTo &&
      profile.reportsTo !== profile.id &&
      visibleById.has(profile.reportsTo)
    ) {
      const siblings = childrenByParent.get(profile.reportsTo) ?? [];
      siblings.push(profile);
      childrenByParent.set(profile.reportsTo, siblings);
    }
  }

  const visited = new Set<string>();
  const visit = (
    profile: OrganisationPerson,
    ancestors: Set<string>,
  ): TreeNode | null => {
    if (visited.has(profile.id) || ancestors.has(profile.id)) return null;

    visited.add(profile.id);
    const nextAncestors = new Set(ancestors).add(profile.id);
    const children = sortPeople(childrenByParent.get(profile.id) ?? [])
      .map((child) => visit(child, nextAncestors))
      .filter((child): child is TreeNode => child !== null);

    return { ...profile, children };
  };

  const roots = sortPeople(
    visible.filter(
      (profile) =>
        !profile.reportsTo ||
        profile.reportsTo === profile.id ||
        !visibleById.has(profile.reportsTo),
    ),
  );
  const forest = roots
    .map((root) => visit(root, new Set()))
    .filter((root): root is TreeNode => root !== null);

  // Keep malformed data visible as a separate root instead of losing people.
  for (const profile of sortPeople(visible)) {
    if (!visited.has(profile.id)) {
      const root = visit(profile, new Set());
      if (root) forest.push(root);
    }
  }

  return forest;
}

function countTreeDescendants(node: TreeNode): number {
  return node.children.reduce(
    (count, child) => count + 1 + countTreeDescendants(child),
    0,
  );
}

function measureNode(
  node: TreeNode,
  collapsedIds: Set<string>,
  depth: number,
  branchLayouts: Readonly<Record<string, BranchLayout>>,
): MeasuredNode {
  const children = collapsedIds.has(node.id)
    ? []
    : node.children.map((child) =>
        measureNode(
          child,
          collapsedIds,
          depth + 1,
          branchLayouts,
        ),
      );

  if (!children.length) {
    return {
      node,
      children,
      groups: [],
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      mode: "leaf",
      depth,
    };
  }

  // Group the same-title direct reports into vertical stacks by default. This
  // keeps a warehouse's labourers/welders together without changing who they
  // report to. Steven's direct leadership area remains side by side.
  // A local visual switch can override either default without altering data.
  const requestedLayout = branchLayouts[node.id];
  const automaticLayout: BranchLayout = isStevenMakris(node)
    ? "horizontal"
    : "grouped";
  const effectiveLayout = requestedLayout ?? automaticLayout;

  if (effectiveLayout === "grouped") {
    const groupsByKey = new Map<string, MeasuredNode[]>();
    for (const child of children) {
      const key = normalise(child.node.position || companyLabels[child.node.company]) || "other";
      const group = groupsByKey.get(key) ?? [];
      group.push(child);
      groupsByKey.set(key, group);
    }
    const groups = [...groupsByKey.entries()].map(([key, groupChildren]) => ({
      key,
      children: groupChildren,
      width: Math.max(
        CARD_WIDTH + STACK_BUS,
        ...groupChildren.map((child) => child.width),
      ),
      height:
        groupChildren.reduce((height, child) => height + child.height, 0) +
        (groupChildren.length - 1) * STACK_GAP,
    }));
    const groupsWidth =
      groups.reduce((width, group) => width + group.width, 0) +
      HORIZONTAL_GAP * (groups.length - 1);

    return {
      node,
      children,
      groups,
      width: Math.max(CARD_WIDTH, groupsWidth),
      height:
        CARD_HEIGHT +
        VERTICAL_GAP +
        Math.max(...groups.map((group) => group.height)),
      mode: "grouped",
      depth,
    };
  }

  if (effectiveLayout === "vertical") {
    return {
      node,
      children,
      groups: [],
      width: Math.max(
        CARD_WIDTH + STACK_BUS,
        ...children.map((child) => child.width),
      ),
      height:
        CARD_HEIGHT +
        VERTICAL_GAP +
        children.reduce((height, child) => height + child.height, 0) +
        (children.length - 1) * STACK_GAP,
      mode: "vertical",
      depth,
    };
  }

  const childrenWidth =
    children.reduce((width, child) => width + child.width, 0) +
    HORIZONTAL_GAP * (children.length - 1);

  return {
    node,
    children,
    groups: [],
    width: Math.max(CARD_WIDTH, childrenWidth),
    height:
      CARD_HEIGHT +
      VERTICAL_GAP +
      Math.max(...children.map((child) => child.height)),
    mode: "horizontal",
    depth,
  };
}

function layoutForest(
  forest: TreeNode[],
  collapsedIds: Set<string>,
  branchLayouts: Readonly<Record<string, BranchLayout>>,
): ChartLayout {
  const boxes = forest.map((root) =>
    measureNode(root, collapsedIds, 0, branchLayouts),
  );
  const contentWidth =
    boxes.reduce((width, box) => width + box.width, 0) +
    Math.max(0, boxes.length - 1) * ROOT_GAP;
  const contentHeight = Math.max(CARD_HEIGHT, ...boxes.map((box) => box.height));
  const positioned: PositionedNode[] = [];
  const connectors: Connector[] = [];

  const place = (
    box: MeasuredNode,
    left: number,
    top: number,
  ) => {
    const x = left + (box.width - CARD_WIDTH) / 2;
    const y = top;
    positioned.push({
      node: box.node,
      x,
      y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      depth: box.depth,
      hasChildren: box.node.children.length > 0,
      childrenLayout:
        box.mode === "leaf"
          ? null
          : box.mode === "vertical"
            ? "vertical"
            : box.mode === "grouped"
              ? "grouped"
              : "horizontal",
      descendantCount: countTreeDescendants(box.node),
    });

    if (!box.children.length) return;

    const parentCenter = x + CARD_WIDTH / 2;
    const parentBottom = y + CARD_HEIGHT;

    if (box.mode === "grouped") {
      const groupsWidth =
        box.groups.reduce((width, group) => width + group.width, 0) +
        HORIZONTAL_GAP * (box.groups.length - 1);
      const groupTop = top + CARD_HEIGHT + VERTICAL_GAP;
      const busTop = parentBottom + VERTICAL_GAP / 2;
      let groupLeft = left + (box.width - groupsWidth) / 2;

      box.groups.forEach((group) => {
        const groupCardX = groupLeft + (group.width - CARD_WIDTH) / 2;
        const groupBusX = groupCardX - STACK_BUS;
        let childTop = groupTop;

        group.children.forEach((child) => {
          const childMiddle = childTop + CARD_HEIGHT / 2;
          place(child, groupCardX - (child.width - CARD_WIDTH) / 2, childTop);
          connectors.push({
            id: `${box.node.id}-${child.node.id}`,
            fromId: box.node.id,
            toId: child.node.id,
            company: child.node.company,
            path: `M ${parentCenter} ${parentBottom} V ${busTop} H ${groupBusX} V ${childMiddle} H ${groupCardX}`,
          });
          childTop += child.height + STACK_GAP;
        });

        groupLeft += group.width + HORIZONTAL_GAP;
      });
      return;
    }

    if (box.mode === "vertical") {
      const childX = x;
      const busX = childX - STACK_BUS;
      let childTop = top + CARD_HEIGHT + VERTICAL_GAP;
      const busTop = parentBottom + VERTICAL_GAP / 2;

      box.children.forEach((child) => {
        const childMiddle = childTop + CARD_HEIGHT / 2;
        place(child, childX - (child.width - CARD_WIDTH) / 2, childTop);
        connectors.push({
          id: `${box.node.id}-${child.node.id}`,
          fromId: box.node.id,
          toId: child.node.id,
          company: child.node.company,
          path: `M ${parentCenter} ${parentBottom} V ${busTop} H ${busX} V ${childMiddle} H ${childX}`,
        });
        childTop += child.height + STACK_GAP;
      });
      return;
    }

    const childrenWidth =
      box.children.reduce((width, child) => width + child.width, 0) +
      HORIZONTAL_GAP * (box.children.length - 1);
    let cursor = left + (box.width - childrenWidth) / 2;
    const childTop = top + CARD_HEIGHT + VERTICAL_GAP;
    const middleY = parentBottom + VERTICAL_GAP / 2;

    box.children.forEach((child) => {
      const childX = cursor + (child.width - CARD_WIDTH) / 2;
      const childCenter = childX + CARD_WIDTH / 2;
      place(child, cursor, childTop);
      connectors.push({
        id: `${box.node.id}-${child.node.id}`,
        fromId: box.node.id,
        toId: child.node.id,
        company: child.node.company,
        path:
          box.children.length === 1
            ? `M ${parentCenter} ${parentBottom} V ${childTop}`
            : `M ${parentCenter} ${parentBottom} V ${middleY} H ${childCenter} V ${childTop}`,
      });
      cursor += child.width + HORIZONTAL_GAP;
    });
  };

  let cursor = CANVAS_MARGIN;
  for (const box of boxes) {
    place(box, cursor, CANVAS_MARGIN);
    cursor += box.width + ROOT_GAP;
  }

  return {
    nodes: positioned,
    connectors,
    width: Math.max(480, contentWidth + CANVAS_MARGIN * 2),
    height: Math.max(360, contentHeight + CANVAS_MARGIN * 2),
  };
}

function getConnectorPath(
  connector: Connector,
  nodesById: Map<string, PositionedNode>,
  offsets: Record<string, NodeOffset>,
) {
  const from = nodesById.get(connector.fromId);
  const to = nodesById.get(connector.toId);
  const fromOffset = offsets[connector.fromId];
  const toOffset = offsets[connector.toId];

  if (!from || !to || (!fromOffset && !toOffset)) return connector.path;

  const fromX = from.x + (fromOffset?.x ?? 0) + from.width / 2;
  const fromY = from.y + (fromOffset?.y ?? 0) + from.height;
  const toX = to.x + (toOffset?.x ?? 0) + to.width / 2;
  const toY = to.y + (toOffset?.y ?? 0);

  if (Math.abs(fromX - toX) < 1) {
    return `M ${fromX} ${fromY} V ${toY}`;
  }

  const middleY = fromY + (toY - fromY) / 2;
  return `M ${fromX} ${fromY} V ${middleY} H ${toX} V ${toY}`;
}

function MobileTreeBranch({
  node,
  collapsedIds,
  highlightedIds,
  selectedId,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  collapsedIds: Set<string>;
  highlightedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const collapsed = collapsedIds.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <li className={styles.mobileBranch} data-company={node.company}>
      <div className={styles.mobileNode}>
        <button
          aria-current={selectedId === node.id ? "true" : undefined}
          className={styles.mobileCard}
          data-company={node.company}
          data-highlighted={highlightedIds.has(node.id)}
          onClick={() => onSelect(node.id)}
          type="button"
        >
          <span className={styles.positionBand}>
            {node.position || companyLabels[node.company]}
          </span>
          <span className={styles.nameBand}>{node.name}</span>
        </button>
        {hasChildren ? (
          <button
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Show" : "Hide"} ${countTreeDescendants(node)} people under ${node.name}`}
            className={styles.mobileToggle}
            onClick={() => onToggle(node.id)}
            type="button"
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" size={16} />
            ) : (
              <ChevronDown aria-hidden="true" size={16} />
            )}
          </button>
        ) : null}
      </div>
      {hasChildren && !collapsed ? (
        <ul className={styles.mobileChildren}>
          {node.children.map((child) => (
            <MobileTreeBranch
              collapsedIds={collapsedIds}
              highlightedIds={highlightedIds}
              key={child.id}
              node={child}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedId={selectedId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function OrganisationTree({
  profiles,
  canArrange: canArrangeProp,
  canEdit = false,
  onCreate,
  onUpdate,
  onOpenEmployeeRecord,
  onRequestWorkEmail,
  className,
}: OrganisationTreeProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [companyFilter, setCompanyFilter] = useState<OrganisationFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [focusedRootId, setFocusedRootId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [openNodeActionsId, setOpenNodeActionsId] = useState<string | null>(
    null,
  );
  const [branchLayouts, setBranchLayouts] = useState<
    Record<string, BranchLayout>
  >({});
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [panning, setPanning] = useState(false);
  const [arrangeMode, setArrangeMode] = useState(false);
  const [manualOffsets, setManualOffsets] = useState<Record<string, NodeOffset>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [linkGuide, setLinkGuide] = useState<LinkGuideState | null>(null);
  const [relationshipHistory, setRelationshipHistory] = useState<RelationshipHistoryEntry[]>([]);
  const [arranging, setArranging] = useState(false);
  const [interactionMessage, setInteractionMessage] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<OrganisationPerson | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [draft, setDraft] = useState<OrganisationPersonDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [workContact, setWorkContact] = useState<{
    personId: string;
    state: "loading" | "ready" | "error";
    email: string | null;
  } | null>(null);
  const titleId = useId();
  const inspectorTitleId = useId();
  const searchResultsId = useId();
  const markerPrefix = useId().replaceAll(":", "");
  const rootRef = useRef<HTMLElement>(null);
  const editorDialogRef = useRef<HTMLElement>(null);
  const disconnectDialogRef = useRef<HTMLDivElement>(null);
  const disconnectKeepButtonRef = useRef<HTMLButtonElement>(null);
  const inspectorDialogRef = useRef<HTMLElement>(null);
  const inspectorCloseButtonRef = useRef<HTMLButtonElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const chartWorldRef = useRef<HTMLDivElement>(null);
  const initialViewportRef = useRef(false);
  const arrangeModeRef = useRef(arrangeMode);
  const suppressCardClickRef = useRef(false);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const pendingOffsetRef = useRef<{ id: string; offset: NodeOffset } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingLinkPointerRef = useRef<{
    clientX: number;
    clientY: number;
    pointer: NodeOffset;
    sourceId: string;
  } | null>(null);
  const linkFrameRef = useRef<number | null>(null);
  const arrangeTimerRef = useRef<number | null>(null);
  const preserveArrangeAfterProfileUpdateRef = useRef(false);
  const preserveInteractionMessageAfterProfileUpdateRef = useRef(false);
  const workContactRequestRef = useRef(0);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  // In the HR portal, employee records are the source of truth. The legacy
  // lightweight chart editor remains available only to older callers that have
  // not supplied the HR record entry point.
  const canArrange = canArrangeProp ?? canEdit;
  const canUseLegacyTreeEditor = canEdit && !onOpenEmployeeRecord;
  const canUseRelationshipEditor = canEdit && Boolean(onUpdate);
  const linkGuideActive = Boolean(linkGuide);
  const closeEditor = useCallback(() => {
    if (!saving) setEditor(null);
  }, [saving]);
  const closeDisconnect = useCallback(() => {
    if (!saving) setPendingDisconnect(null);
  }, [saving]);
  const closeInspector = useCallback(() => {
    workContactRequestRef.current += 1;
    setWorkContact(null);
    setSelectedId(null);
  }, []);
  useDialogFocus(Boolean(editor), editorDialogRef, null, closeEditor);
  useDialogFocus(
    Boolean(pendingDisconnect),
    disconnectDialogRef,
    disconnectKeepButtonRef,
    closeDisconnect,
  );
  const profileLayoutKey = useMemo(
    () =>
      profiles
        .map(
          (profile) =>
            `${profile.id}\u0000${profile.name}\u0000${profile.position}\u0000${profile.company}\u0000${profile.reportsTo ?? ""}\u0000${profile.sortOrder ?? ""}\u0000${profile.isActive ?? ""}`,
        )
        .join("\u0001"),
    [profiles],
  );

  useEffect(() => {
    arrangeModeRef.current = arrangeMode;
  }, [arrangeMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (linkGuideActive) {
        pendingLinkPointerRef.current = null;
        if (linkFrameRef.current !== null) {
          window.cancelAnimationFrame(linkFrameRef.current);
          linkFrameRef.current = null;
        }
        setLinkGuide(null);
        dropTargetRef.current = null;
        setDropTarget(null);
        setInteractionMessage("Add line cancelled.");
      } else if (pendingDisconnect) closeDisconnect();
      else if (openNodeActionsId) setOpenNodeActionsId(null);
      else if (editor && !saving) setEditor(null);
      else if (selectedId) closeInspector();
    };
    const handleFullscreen = () => {
      const active = document.fullscreenElement === rootRef.current;
      setFullscreen(active);
      // Full-screen is the editing canvas. Entering it directly should expose
      // the same drag-and-drop mode as the Arrange button.
      if (active) setArrangeMode(canArrange);
      if (!active) {
        if (linkGuideActive) setInteractionMessage("Add line cancelled.");
        const activeDrag = nodeDragRef.current;
        if (activeDrag) {
          setManualOffsets((current) => {
            const next = { ...current };
            if (activeDrag.startedWithManualOffset) next[activeDrag.id] = activeDrag.startOffset;
            else delete next[activeDrag.id];
            return next;
          });
        }
        nodeDragRef.current = null;
        pendingOffsetRef.current = null;
        if (dragFrameRef.current !== null) {
          window.cancelAnimationFrame(dragFrameRef.current);
          dragFrameRef.current = null;
        }
        pendingLinkPointerRef.current = null;
        if (linkFrameRef.current !== null) {
          window.cancelAnimationFrame(linkFrameRef.current);
          linkFrameRef.current = null;
        }
        panRef.current = null;
        setDraggingNodeId(null);
        setPanning(false);
        setArrangeMode(false);
        setLinkGuide(null);
        dropTargetRef.current = null;
        setDropTarget(null);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("fullscreenchange", handleFullscreen);
    };
  }, [canArrange, closeDisconnect, closeInspector, editor, linkGuideActive, openNodeActionsId, pendingDisconnect, saving, selectedId]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
      if (linkFrameRef.current !== null) {
        window.cancelAnimationFrame(linkFrameRef.current);
      }
      if (arrangeTimerRef.current !== null) {
        window.clearTimeout(arrangeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const mobileQuery = window.matchMedia(MOBILE_CHART_QUERY);
    const leaveDesktopEditing = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        setInteractionMessage((current) => current === "Desktop editing closed because the chart moved to the mobile layout." ? "" : current);
        return;
      }

      const activeDrag = nodeDragRef.current;
      if (activeDrag) {
        setManualOffsets((current) => {
          const next = { ...current };
          if (activeDrag.startedWithManualOffset) next[activeDrag.id] = activeDrag.startOffset;
          else delete next[activeDrag.id];
          return next;
        });
      }
      nodeDragRef.current = null;
      pendingOffsetRef.current = null;
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      pendingLinkPointerRef.current = null;
      if (linkFrameRef.current !== null) {
        window.cancelAnimationFrame(linkFrameRef.current);
        linkFrameRef.current = null;
      }
      panRef.current = null;
      dropTargetRef.current = null;
      setDraggingNodeId(null);
      setPanning(false);
      setArrangeMode(false);
      setLinkGuide(null);
      setDropTarget(null);
      setOpenNodeActionsId(null);
      setInteractionMessage("Desktop editing closed because the chart moved to the mobile layout.");

      if (document.fullscreenElement === rootRef.current) {
        void document.exitFullscreen().catch(() => {
          setInteractionMessage("Use Escape to leave full screen and continue in the mobile layout.");
        });
      }
    };

    mobileQuery.addEventListener("change", leaveDesktopEditing);
    return () => mobileQuery.removeEventListener("change", leaveDesktopEditing);
  }, []);

  useEffect(() => {
    const preserveArrange = (
      preserveArrangeAfterProfileUpdateRef.current
      || arrangeModeRef.current
    ) && document.fullscreenElement === rootRef.current;
    const preserveInteractionMessage = preserveInteractionMessageAfterProfileUpdateRef.current;
    preserveArrangeAfterProfileUpdateRef.current = false;
    preserveInteractionMessageAfterProfileUpdateRef.current = false;
    pendingLinkPointerRef.current = null;
    if (linkFrameRef.current !== null) {
      window.cancelAnimationFrame(linkFrameRef.current);
      linkFrameRef.current = null;
    }
    const timer = window.setTimeout(() => {
      setManualOffsets({});
      setArrangeMode(preserveArrange);
      setDraggingNodeId(null);
      dropTargetRef.current = null;
      setDropTarget(null);
      setLinkGuide(null);
      if (!preserveInteractionMessage) setInteractionMessage("");
      setOpenNodeActionsId(null);
      setBranchLayouts({});
    }, 0);

    return () => window.clearTimeout(timer);
  }, [profileLayoutKey]);

  const orderedProfiles = useMemo(() => sortPeople(profiles), [profiles]);
  const profileById = useMemo(
    () => new Map(orderedProfiles.map((profile) => [profile.id, profile])),
    [orderedProfiles],
  );

  const companyScopeIds = useMemo(() => {
    const matches = orderedProfiles.filter((profile) => {
      if (companyFilter === "all") return true;
      if (companyFilter === "mam" || companyFilter === "equipsy") {
        return profile.company === companyFilter;
      }
      const searchable = normalise(`${profile.name} ${profile.position}`);
      return searchable.includes(companyFilter);
    });
    const ids = new Set(matches.map((profile) => profile.id));
    // Team filters represent a whole reporting branch. Keep the selected
    // leader's descendants visible, then add ancestors for chart context.
    if (companyFilter === "major" || companyFilter === "minor" || companyFilter === "warehouse") {
      for (const profile of matches) {
        for (const descendantId of getDescendantIds(profile.id, orderedProfiles)) {
          ids.add(descendantId);
        }
      }
    }
    // Preserve cross-company reporting context, such as Steven → Equipsy.
    return addAncestorIds(ids, profileById);
  }, [companyFilter, orderedProfiles, profileById]);

  const focusScopeIds = useMemo(() => {
    if (!focusedRootId || !profileById.has(focusedRootId)) return companyScopeIds;
    return addAncestorIds(
      getDescendantIds(focusedRootId, orderedProfiles).add(focusedRootId),
      profileById,
    );
  }, [companyScopeIds, focusedRootId, orderedProfiles, profileById]);

  const searchMatches = useMemo(() => {
    const cleaned = normalise(query);
    if (!cleaned) return [];
    return orderedProfiles.filter(
      (profile) =>
        focusScopeIds.has(profile.id) &&
        normalise(
          `${profile.name} ${profile.position} ${companyLabels[profile.company]}`,
        ).includes(cleaned),
    );
  }, [focusScopeIds, orderedProfiles, query]);

  const visibleSearchMatches = useMemo(
    () => searchMatches.slice(0, 8),
    [searchMatches],
  );
  const activeSearchResultIndex = Math.min(
    activeSearchIndex,
    Math.max(visibleSearchMatches.length - 1, 0),
  );

  const matchingIds = useMemo(
    () => new Set(searchMatches.map((profile) => profile.id)),
    [searchMatches],
  );

  const visibleIds = useMemo(() => {
    if (!normalise(query)) return focusScopeIds;
    return addAncestorIds(matchingIds, profileById);
  }, [focusScopeIds, matchingIds, profileById, query]);

  const forest = useMemo(
    () => buildForest(orderedProfiles, visibleIds),
    [orderedProfiles, visibleIds],
  );

  const searchAncestorIds = useMemo(() => {
    if (!normalise(query)) return new Set<string>();
    const ancestors = addAncestorIds(matchingIds, profileById);
    for (const id of matchingIds) ancestors.delete(id);
    return ancestors;
  }, [matchingIds, profileById, query]);

  const effectiveCollapsedIds = useMemo(() => {
    if (!searchAncestorIds.size) return collapsedIds;
    return new Set(
      [...collapsedIds].filter((id) => !searchAncestorIds.has(id)),
    );
  }, [collapsedIds, searchAncestorIds]);

  const layout = useMemo(
    () => layoutForest(forest, effectiveCollapsedIds, branchLayouts),
    [branchLayouts, effectiveCollapsedIds, forest],
  );
  // A PDF should retain the complete reporting structure even when someone has
  // temporarily collapsed a branch in their interactive view.
  const printableLayout = useMemo(
    () => layoutForest(forest, new Set<string>(), branchLayouts),
    [branchLayouts, forest],
  );
  const layoutNodesById = useMemo(
    () => new Map(layout.nodes.map((item) => [item.node.id, item])),
    [layout.nodes],
  );

  const selectedProfile = selectedId ? profileById.get(selectedId) : undefined;
  const mobileInspectorOpen = Boolean(selectedProfile && isMobileViewport);
  useDialogFocus(
    mobileInspectorOpen,
    inspectorDialogRef,
    inspectorCloseButtonRef,
    closeInspector,
  );
  const selectedManager = selectedProfile?.reportsTo
    ? profileById.get(selectedProfile.reportsTo)
    : undefined;
  const selectedReports = useMemo(
    () =>
      selectedProfile
        ? orderedProfiles.filter(
            (profile) => profile.reportsTo === selectedProfile.id,
          )
        : [],
    [orderedProfiles, selectedProfile],
  );
  const selectedTeamSize = selectedProfile
    ? getDescendantIds(selectedProfile.id, orderedProfiles).size
    : 0;
  const relatedIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    return addAncestorIds(
      getDescendantIds(selectedId, orderedProfiles).add(selectedId),
      profileById,
    );
  }, [orderedProfiles, profileById, selectedId]);
  const primaryRootId = useMemo(
    () =>
      [...forest].sort(
        (left, right) =>
          countTreeDescendants(right) - countTreeDescendants(left),
      )[0]?.id ?? null,
    [forest],
  );

  const requestWorkContact = (personId: string) => {
    const profile = profileById.get(personId);
    const requestId = workContactRequestRef.current + 1;
    workContactRequestRef.current = requestId;

    if (!profile || !isPerson(profile) || !onRequestWorkEmail) {
      setWorkContact(null);
      return;
    }

    setWorkContact({ personId, state: "loading", email: null });
    void onRequestWorkEmail(personId)
      .then((email) => {
        if (workContactRequestRef.current !== requestId) return;
        setWorkContact({
          personId,
          state: "ready",
          email: safeWorkEmail(email),
        });
      })
      .catch(() => {
        if (workContactRequestRef.current !== requestId) return;
        setWorkContact({ personId, state: "error", email: null });
      });
  };

  const activeEditor =
    (canUseLegacyTreeEditor || canUseRelationshipEditor) &&
    (editor?.mode === "create"
      ? canUseLegacyTreeEditor
      : editor?.mode === "update" &&
        profiles.some(
          (profile) => profile.id === editor.id && isPerson(profile),
        ))
      ? editor
      : null;
  const editorProfile =
    activeEditor?.mode === "update"
      ? profileById.get(activeEditor.id)
      : undefined;
  const excludedManagerIds = useMemo(() => {
    if (!editorProfile) return new Set<string>();
    return getDescendantIds(editorProfile.id, profiles).add(editorProfile.id);
  }, [editorProfile, profiles]);
  const managerOptions = sortPeople(
    profiles.filter((profile) => !excludedManagerIds.has(profile.id)),
  );
  const duplicateManagerLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of managerOptions) {
      const key = `${profile.name}\u0000${profile.position}\u0000${profile.company}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [managerOptions]);

  const visiblePersonCount = orderedProfiles.filter(
    (profile) => isPerson(profile) && visibleIds.has(profile.id),
  ).length;
  const activeFocus = focusedRootId
    ? profileById.get(focusedRootId)
    : undefined;

  const centerNode = (id: string, delay = 40) => {
    window.setTimeout(() => {
      const viewport = viewportRef.current;
      const node = Array.from(
        viewport?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [],
      ).find((element) => element.dataset.nodeId === id);
      if (!viewport || !node) return;
      const viewportRect = viewport.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      viewport.scrollTo({
        behavior: getScrollBehavior(),
        left:
          viewport.scrollLeft +
          nodeRect.left -
          viewportRect.left -
          (viewport.clientWidth - nodeRect.width) / 2,
        top:
          viewport.scrollTop +
          nodeRect.top -
          viewportRect.top -
          (viewport.clientHeight - nodeRect.height) / 2,
      });
    }, delay);
  };

  useEffect(() => {
    if (initialViewportRef.current || !primaryRootId) return;
    let frame = 0;
    let attempts = 0;
    const fitInitialViewport = () => {
      const viewport = viewportRef.current;
      if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
        attempts += 1;
        if (attempts < 12) frame = window.requestAnimationFrame(fitInitialViewport);
        return;
      }
      initialViewportRef.current = true;
      const nextZoom = Math.max(
        MIN_ZOOM,
        Math.min(
          DEFAULT_ZOOM,
          (viewport.clientWidth - 48) / layout.width,
          (viewport.clientHeight - 86) / layout.height,
        ),
      );
      setZoom(nextZoom);
      frame = window.requestAnimationFrame(() => {
        viewport.scrollTo({
          behavior: "auto",
          left: Math.max(0, (layout.width * nextZoom - viewport.clientWidth) / 2),
          top: 0,
        });
      });
    };
    frame = window.requestAnimationFrame(fitInitialViewport);

    return () => window.cancelAnimationFrame(frame);
  }, [layout.height, layout.width, primaryRootId]);

  const expandAncestorBranches = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      let managerId = profileById.get(id)?.reportsTo;
      const seen = new Set<string>();
      while (managerId && !seen.has(managerId)) {
        seen.add(managerId);
        next.delete(managerId);
        managerId = profileById.get(managerId)?.reportsTo;
      }
      return next;
    });
  };

  const selectProfile = (id: string) => {
    if (!visibleIds.has(id)) {
      setCompanyFilter("all");
      setFocusedRootId(null);
      setQuery("");
    }
    expandAncestorBranches(id);
    setOpenNodeActionsId(null);
    setSelectedId(id);
    requestWorkContact(id);
    setSearchOpen(false);
    centerNode(id, visibleIds.has(id) ? 30 : 100);
  };

  const selectSearchResult = (id: string) => {
    expandAncestorBranches(id);
    setOpenNodeActionsId(null);
    setQuery("");
    setSearchOpen(false);
    setSelectedId(id);
    requestWorkContact(id);
    centerNode(id, 100);
  };

  const focusTeam = (id: string) => {
    setFocusedRootId(id);
    setCompanyFilter("all");
    setQuery("");
    setCollapsedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    centerNode(id, 100);
  };

  const showFullOrganisation = () => {
    setFocusedRootId(null);
    setCompanyFilter("all");
    setQuery("");
    if (selectedId) centerNode(selectedId, 100);
  };

  const exportPdf = () => {
    if (!printableLayout.nodes.length) {
      setInteractionMessage("There is no organisation chart to export yet.");
      return;
    }

    // Open the window synchronously from the click handler so browsers do not
    // treat the PDF export as an unsolicited pop-up.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setInteractionMessage(
        "The PDF window was blocked. Allow pop-ups for this site and try again.",
      );
      return;
    }

    try {
      printWindow.opener = null;
    } catch {
      // The document contains no private directory data, and the popup remains
      // usable even in browsers that do not permit changing its opener.
    }

    const companyScope = organisationFilterLabels[companyFilter];
    const scopePrefix = [
      activeFocus ? `${activeFocus.name}'s team` : "",
      normalise(query) ? `Search: ${query.trim()}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const scope = scopePrefix ? `${scopePrefix} · ${companyScope}` : companyScope;
    const personCount = printableLayout.nodes.filter((item) =>
      isPerson(item.node),
    ).length;

    printWindow.document.open();
    printWindow.document.write(
      buildOrganisationPdfDocument(
        printableLayout,
        "Organisation chart",
        scope,
        personCount,
      ),
    );
    printWindow.document.close();
    setInteractionMessage(
      "Your organisation chart is ready to print or save as a PDF.",
    );
  };

  const toggleBranch = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleNodeActions = (id: string) => {
    setOpenNodeActionsId((current) => (current === id ? null : id));
  };

  const toggleBranchLayout = (id: string, currentLayout: BranchLayout) => {
    const nextLayout: BranchLayout = currentLayout === "grouped"
      ? "horizontal"
      : currentLayout === "horizontal"
        ? "vertical"
        : "grouped";
    setBranchLayouts((current) => ({
      ...current,
      [id]: nextLayout,
    }));
    setInteractionMessage(
      nextLayout === "grouped"
        ? "Same-title reports are now grouped vertically."
        : nextLayout === "vertical"
          ? "Reports are now arranged in one vertical stack."
          : "Reports are now arranged side by side.",
    );
  };

  const fitChart = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextZoom = Math.max(
      MIN_ZOOM,
      Math.min(
        1,
        (viewport.clientWidth - 48) / layout.width,
        (viewport.clientHeight - 86) / layout.height,
      ),
    );
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        behavior: getScrollBehavior(),
        left: Math.max(0, (layout.width * nextZoom - viewport.clientWidth) / 2),
        top: 0,
      });
    });
  };

  const cleanUpChart = () => {
    if (!canArrange) return;
    const hasManualPositions = Object.keys(manualOffsets).length > 0;
    setArrangeMode(false);
    setDraggingNodeId(null);

    if (!hasManualPositions) {
      setInteractionMessage("The chart already matches the reporting structure.");
      return;
    }

    if (arrangeTimerRef.current !== null) {
      window.clearTimeout(arrangeTimerRef.current);
    }
    setArranging(true);
    setManualOffsets({});
    setInteractionMessage("Chart restored to the reporting structure.");
    arrangeTimerRef.current = window.setTimeout(() => {
      arrangeTimerRef.current = null;
      setArranging(false);
    }, ARRANGE_DURATION);
  };

  const requestOrganisationFullscreen = async () => {
    const root = rootRef.current;
    if (!root) return false;
    if (document.fullscreenElement === root) return true;
    try {
      await root.requestFullscreen();
      setInteractionMessage((current) => current === "Full screen could not be opened. Check your browser permissions and try again." ? "" : current);
      return true;
    } catch {
      setInteractionMessage("Full screen could not be opened. Check your browser permissions and try again.");
      return false;
    }
  };

  const toggleArrangeMode = async () => {
    if (!canArrange) return;
    if (window.matchMedia(MOBILE_CHART_QUERY).matches) {
      setInteractionMessage("Arrange mode is available on a larger screen.");
      return;
    }
    if (linkGuide) {
      pendingLinkPointerRef.current = null;
      if (linkFrameRef.current !== null) {
        window.cancelAnimationFrame(linkFrameRef.current);
        linkFrameRef.current = null;
      }
      setLinkGuide(null);
      dropTargetRef.current = null;
      setDropTarget(null);
    }
    if (arrangeMode) {
      setArrangeMode(false);
      setInteractionMessage(
        "Arrange mode off. Local positions remain until you clean up the chart or refresh.",
      );
      return;
    }

    if (!(await requestOrganisationFullscreen())) return;

    workContactRequestRef.current += 1;
    setWorkContact(null);
    setSelectedId(null);
    setArrangeMode(true);
    setInteractionMessage(
      canUseRelationshipEditor
        ? "Arrange mode on. Drop beside a card for peers, above it to become its manager, or below it to report to it."
        : "Arrange mode on. Drag a person to compare positions. Clean up restores the reporting layout.",
    );
  };

  const resetView = () => {
    setFocusedRootId(null);
    setCompanyFilter("all");
    setQuery("");
    setSelectedId(null);
    workContactRequestRef.current += 1;
    setWorkContact(null);
    setCollapsedIds(new Set());
    setBranchLayouts({});
    setZoom(DEFAULT_ZOOM);
    setArrangeMode(false);
    setManualOffsets({});
    setInteractionMessage("");
    const viewport = viewportRef.current;
    if (!viewport) return;
    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        behavior: getScrollBehavior(),
        left: Math.max(
          0,
          (layout.width * DEFAULT_ZOOM - viewport.clientWidth) / 2,
        ),
        top: 0,
      });
    });
  };

  const toggleFullscreen = async () => {
    const root = rootRef.current;
    if (!root) return;
    try {
      if (document.fullscreenElement === root) {
        await document.exitFullscreen();
      } else {
        await requestOrganisationFullscreen();
      }
    } catch {
      setInteractionMessage("Full screen could not be opened. Check your browser permissions and try again.");
    }
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (linkGuide && !target.closest("[data-link-target]")) {
      pendingLinkPointerRef.current = null;
      if (linkFrameRef.current !== null) {
        window.cancelAnimationFrame(linkFrameRef.current);
        linkFrameRef.current = null;
      }
      setLinkGuide(null);
      setCurrentDropTarget(null);
      setInteractionMessage("Add line cancelled.");
      return;
    }
    if (target.closest("button, input, select, label, aside")) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const viewport = viewportRef.current;
    if (!pan || !viewport || pan.pointerId !== event.pointerId) return;
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.y);
  };

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
  };

  const handleViewportKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.target !== event.currentTarget) return;
    const directions: Record<string, { left?: number; top?: number }> = {
      ArrowDown: { top: 140 },
      ArrowLeft: { left: -140 },
      ArrowRight: { left: 140 },
      ArrowUp: { top: -140 },
    };
    const direction = directions[event.key];
    const viewport = viewportRef.current;
    if (!direction || !viewport) return;

    event.preventDefault();
    viewport.scrollBy({ ...direction, behavior: getScrollBehavior() });
  };

  const flushPendingOffset = () => {
    const pending = pendingOffsetRef.current;
    if (!pending) return;
    pendingOffsetRef.current = null;
    dragFrameRef.current = null;
    setManualOffsets((current) => ({ ...current, [pending.id]: pending.offset }));
  };

  const scheduleOffset = (id: string, offset: NodeOffset) => {
    pendingOffsetRef.current = { id, offset };
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(flushPendingOffset);
  };

  const setCurrentDropTarget = (next: DropTarget | null) => {
    const current = dropTargetRef.current;
    if (current?.id === next?.id && current?.intent === next?.intent) return;
    dropTargetRef.current = next;
    setDropTarget(next);
  };

  const pointInChart = (clientX: number, clientY: number): NodeOffset | null => {
    const world = chartWorldRef.current;
    if (!world) return null;
    const rect = world.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / zoom, 0, layout.width),
      y: clamp((clientY - rect.top) / zoom, 0, layout.height),
    };
  };

  const detectDropTargetAt = (
    clientX: number,
    clientY: number,
    draggedId: string,
  ): DropTarget | null => {
    if (!canUseRelationshipEditor) return null;
    const descendants = getDescendantIds(draggedId, orderedProfiles);
    const candidates = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [])]
      .filter((element) => {
        const targetId = element.dataset.nodeId;
        return Boolean(targetId && targetId !== draggedId && profileById.has(targetId) && !descendants.has(targetId));
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
        const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
        return { element, rect, distance: Math.hypot(dx, dy) };
      })
      .filter(({ rect, distance }) => rect.width > 0 && rect.height > 0 && distance <= Math.max(DROP_SNAP_X, DROP_SNAP_Y))
      .sort((first, second) => first.distance - second.distance);

    const candidate = candidates[0];
    const targetId = candidate?.element.dataset.nodeId;
    if (!candidate || !targetId) return null;
    const { rect } = candidate;
    const targetProfile = profileById.get(targetId);
    if (!targetProfile) return null;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const anchors: Array<{ intent: DropIntent; distance: number }> = [
      {
        intent: "target-reports-to-dragged",
        distance: Math.hypot(clientX - centerX, clientY - (rect.top - 18)),
      },
      {
        intent: "report-to-target",
        distance: Math.hypot(clientX - centerX, clientY - (rect.bottom + 18)),
      },
      {
        intent: "sibling",
        distance: Math.min(
          Math.hypot(clientX - (rect.left - 18), clientY - centerY),
          Math.hypot(clientX - (rect.right + 18), clientY - centerY),
        ),
      },
    ];
    anchors.sort((first, second) => first.distance - second.distance);
    const intent = anchors[0]?.intent;
    if (!intent || (intent === "target-reports-to-dragged" && !isPerson(targetProfile))) return null;
    return { id: targetId, intent };
  };

  const flushLinkPointer = () => {
    const pending = pendingLinkPointerRef.current;
    pendingLinkPointerRef.current = null;
    linkFrameRef.current = null;
    if (!pending || document.fullscreenElement !== rootRef.current) return;
    setLinkGuide((current) => current?.sourceId === pending.sourceId
      ? { ...current, pointer: pending.pointer }
      : current);
    setCurrentDropTarget(detectDropTargetAt(
      pending.clientX,
      pending.clientY,
      pending.sourceId,
    ));
  };

  const moveLinkGuide = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!linkGuide || document.fullscreenElement !== rootRef.current) return;
    const pointer = pointInChart(event.clientX, event.clientY);
    if (!pointer) return;
    pendingLinkPointerRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointer,
      sourceId: linkGuide.sourceId,
    };
    if (linkFrameRef.current === null) {
      linkFrameRef.current = window.requestAnimationFrame(flushLinkPointer);
    }
  };

  const animateCleanUp = () => {
    if (arrangeTimerRef.current !== null) window.clearTimeout(arrangeTimerRef.current);
    setManualOffsets({});
    setArranging(true);
    arrangeTimerRef.current = window.setTimeout(() => {
      arrangeTimerRef.current = null;
      setArranging(false);
    }, ARRANGE_DURATION);
  };

  const persistReportsTo = async (
    person: OrganisationPerson,
    nextReportsTo: string | null,
    message: string,
    recordHistory = true,
  ) => {
    if (!canUseRelationshipEditor || !onUpdate || !isPerson(person) || saving) return false;
    const descendants = getDescendantIds(person.id, orderedProfiles);
    if (nextReportsTo === person.id || (nextReportsTo ? descendants.has(nextReportsTo) : false)) {
      setInteractionMessage("That connection would create a reporting cycle.");
      return false;
    }
    if (nextReportsTo === person.reportsTo) {
      setInteractionMessage("That card is already in this reporting group.");
      return false;
    }

    setSaving(true);
    setError("");
    try {
      preserveArrangeAfterProfileUpdateRef.current = arrangeMode
        && document.fullscreenElement === rootRef.current;
      preserveInteractionMessageAfterProfileUpdateRef.current = true;
      await onUpdate(person.id, {
        name: person.name,
        position: person.position,
        company: person.company,
        reportsTo: nextReportsTo,
        kind: "person",
      });
      if (recordHistory) {
        setRelationshipHistory((current) => [...current.slice(-19), {
          personId: person.id,
          previousReportsTo: person.reportsTo,
          nextReportsTo,
        }]);
      }
      animateCleanUp();
      setInteractionMessage(message);
      return true;
    } catch (caught) {
      preserveArrangeAfterProfileUpdateRef.current = false;
      preserveInteractionMessageAfterProfileUpdateRef.current = false;
      setInteractionMessage(caught instanceof Error ? caught.message : "The reporting connection could not be saved.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const persistDropRelationship = async (dragged: OrganisationPerson, target: DropTarget) => {
    const targetProfile = profileById.get(target.id);
    if (!targetProfile) return false;
    if (target.intent === "target-reports-to-dragged") {
      return persistReportsTo(targetProfile, dragged.id, `${dragged.name} is now ${targetProfile.name}'s manager.`);
    }
    const nextReportsTo = target.intent === "sibling" ? targetProfile.reportsTo : targetProfile.id;
    return persistReportsTo(
      dragged,
      nextReportsTo,
      target.intent === "sibling"
        ? `${dragged.name} is now grouped with ${targetProfile.name}.`
        : `${dragged.name} now reports to ${targetProfile.name}.`,
    );
  };

  const undoLastRelationship = async () => {
    const last = relationshipHistory.at(-1);
    if (!last || saving) return;
    const person = profileById.get(last.personId);
    if (!person) {
      setRelationshipHistory((current) => current.slice(0, -1));
      setInteractionMessage("That previous person is no longer in this chart.");
      return;
    }
    const restored = await persistReportsTo(person, last.previousReportsTo, `Restored ${person.name}'s previous reporting line.`, false);
    if (restored) setRelationshipHistory((current) => current.slice(0, -1));
  };

  const startNodeDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    node: PositionedNode,
  ) => {
    if (
      saving
      || !canArrange
      || !arrangeMode
      || document.fullscreenElement !== rootRef.current
      || event.button !== 0
      || !isPerson(node.node)
    ) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragRef.current = {
      id: node.node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: manualOffsets[node.node.id] ?? { x: 0, y: 0 },
      startedWithManualOffset: manualOffsets[node.node.id] !== undefined,
      node,
      moved: false,
    };
    setDraggingNodeId(node.node.id);
  };

  const moveNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (document.fullscreenElement !== rootRef.current) {
      setManualOffsets((current) => {
        const next = { ...current };
        if (drag.startedWithManualOffset) next[drag.id] = drag.startOffset;
        else delete next[drag.id];
        return next;
      });
      nodeDragRef.current = null;
      pendingOffsetRef.current = null;
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDraggingNodeId(null);
      setCurrentDropTarget(null);
      return;
    }

    const deltaX = (event.clientX - drag.startX) / zoom;
    const deltaY = (event.clientY - drag.startY) / zoom;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;

    drag.moved = true;
    event.preventDefault();
    event.stopPropagation();
    setCurrentDropTarget(detectDropTargetAt(event.clientX, event.clientY, drag.id));
    const desiredWorldX = drag.node.x + drag.startOffset.x + deltaX;
    const desiredWorldY = drag.node.y + drag.startOffset.y + deltaY;
    const minimumWorldX = Math.ceil(CANVAS_MARGIN / GRID_SIZE) * GRID_SIZE;
    const minimumWorldY = Math.ceil(CANVAS_MARGIN / GRID_SIZE) * GRID_SIZE;
    const maximumWorldX = Math.max(
      minimumWorldX,
      Math.floor((layout.width - CANVAS_MARGIN - drag.node.width) / GRID_SIZE) * GRID_SIZE,
    );
    const maximumWorldY = Math.max(
      minimumWorldY,
      Math.floor((layout.height - CANVAS_MARGIN - drag.node.height) / GRID_SIZE) * GRID_SIZE,
    );
    scheduleOffset(drag.id, {
      x: clamp(
        Math.round(desiredWorldX / GRID_SIZE) * GRID_SIZE,
        minimumWorldX,
        maximumWorldX,
      ) - drag.node.x,
      y: clamp(
        Math.round(desiredWorldY / GRID_SIZE) * GRID_SIZE,
        minimumWorldY,
        maximumWorldY,
      ) - drag.node.y,
    });
  };

  const finishNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const canCommit = event.type === "pointerup"
      && document.fullscreenElement === rootRef.current;
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
      if (canCommit) flushPendingOffset();
      else pendingOffsetRef.current = null;
    }
    if (!canCommit && drag.moved) {
      setManualOffsets((current) => {
        const next = { ...current };
        if (drag.startedWithManualOffset) next[drag.id] = drag.startOffset;
        else delete next[drag.id];
        return next;
      });
    }
    // Clear the ref before releasing capture: releasePointerCapture may fire
    // lostpointercapture synchronously, and a second finish used to replay the
    // relationship mutation and leave subsequent drags stuck.
    nodeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setDraggingNodeId(null);
    const nextDropTarget = dropTargetRef.current;
    setCurrentDropTarget(null);
    if (drag.moved) {
      suppressCardClickRef.current = true;
      window.setTimeout(() => {
        suppressCardClickRef.current = false;
      }, 0);
      if (canCommit && nextDropTarget && canUseRelationshipEditor) {
        void persistDropRelationship(drag.node.node, nextDropTarget);
      } else if (canCommit) {
        setInteractionMessage(`${drag.node.node.name} moved on the grid. Clean up restores the reporting layout.`);
      }
      return;
    }

    if (canCommit) {
      suppressCardClickRef.current = true;
      selectProfile(drag.id);
      window.setTimeout(() => {
        suppressCardClickRef.current = false;
      }, 0);
    }
  };

  const openCreate = (
    reportsTo: string | null = null,
    company: OrganisationCompany =
      companyFilter === "mam" || companyFilter === "equipsy" ? companyFilter : "mam",
  ) => {
    if (!canUseLegacyTreeEditor) return;
    if (isMobileViewport) closeInspector();
    setDraft({ ...emptyDraft, company, reportsTo });
    setError("");
    setEditor({ mode: "create" });
  };

  const openUpdate = (profile: OrganisationPerson) => {
    if ((!canUseLegacyTreeEditor && !canUseRelationshipEditor) || !isPerson(profile)) return;
    if (isMobileViewport) closeInspector();
    setDraft({
      name: profile.name,
      position: profile.position,
      company: profile.company,
      reportsTo: profile.reportsTo,
      kind: "person",
    });
    setError("");
    setEditor({ mode: "update", id: profile.id });
  };

  const startReportingLinkGuide = async (profile: OrganisationPerson) => {
    setOpenNodeActionsId(null);
    if (!canUseRelationshipEditor || !isPerson(profile) || saving) {
      setInteractionMessage("Only HR can edit reporting links.");
      return;
    }
    pendingLinkPointerRef.current = null;
    if (linkFrameRef.current !== null) {
      window.cancelAnimationFrame(linkFrameRef.current);
      linkFrameRef.current = null;
    }
    setLinkGuide(null);
    setCurrentDropTarget(null);
    if (!(await requestOrganisationFullscreen())) return;

    // Fullscreen requests yield to the browser. Cancel again so an animation
    // frame queued by the previous source cannot update this new guide.
    pendingLinkPointerRef.current = null;
    if (linkFrameRef.current !== null) {
      window.cancelAnimationFrame(linkFrameRef.current);
      linkFrameRef.current = null;
    }

    const item = layoutNodesById.get(profile.id);
    const offset = manualOffsets[profile.id] ?? { x: 0, y: 0 };
    const pointer = item
      ? {
          x: item.x + offset.x + item.width / 2,
          y: item.y + offset.y + item.height / 2,
        }
      : { x: layout.width / 2, y: layout.height / 2 };
    setArrangeMode(false);
    setSelectedId(null);
    setLinkGuide({ sourceId: profile.id, pointer });
    setInteractionMessage(`Add line from ${profile.name}: choose the top, side or bottom + on another card. Click blank space or press Escape to cancel.`);
  };

  const finishReportingLinkGuide = async (target: DropTarget) => {
    const source = linkGuide ? profileById.get(linkGuide.sourceId) : undefined;
    if (
      !source
      || saving
      || document.fullscreenElement !== rootRef.current
    ) return;
    const saved = await persistDropRelationship(source, target);
    if (saved) {
      pendingLinkPointerRef.current = null;
      if (linkFrameRef.current !== null) {
        window.cancelAnimationFrame(linkFrameRef.current);
        linkFrameRef.current = null;
      }
      setLinkGuide(null);
      setCurrentDropTarget(null);
    }
  };

  const openReportingLinkEditor = (profile: OrganisationPerson) => {
    setOpenNodeActionsId(null);

    if (!isPerson(profile)) {
      setInteractionMessage(
        "Reporting links for team groups are managed from the HR directory.",
      );
      return;
    }

    if (canUseRelationshipEditor) {
      openUpdate(profile);
      return;
    }

    if (onOpenEmployeeRecord) {
      onOpenEmployeeRecord(profile.id);
      return;
    }

    setInteractionMessage("Only HR can edit reporting links.");
  };

  const disconnectReportingLine = (profile: OrganisationPerson) => {
    setOpenNodeActionsId(null);
    if (!canUseRelationshipEditor || !profile.reportsTo) {
      setInteractionMessage(profile.reportsTo ? "Only HR can edit reporting links." : `${profile.name} is already top level.`);
      return;
    }
    setPendingDisconnect(profile);
  };

  const confirmDisconnect = () => {
    const profile = pendingDisconnect;
    if (!profile) return;
    setPendingDisconnect(null);
    void persistReportsTo(profile, null, `${profile.name} is now top level.`);
  };

  const savePerson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeEditor) return;

    const cleanDraft: OrganisationPersonDraft = {
      name: draft.name.trim(),
      position: draft.position.trim(),
      company: draft.company,
      reportsTo: draft.reportsTo || null,
      kind: "person",
    };
    if (!cleanDraft.name || !cleanDraft.position) {
      setError("Add a name and position.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      if (activeEditor.mode === "create") {
        if (!onCreate) throw new Error("Adding people is not connected yet.");
        await onCreate(cleanDraft);
      } else {
        if (!onUpdate) throw new Error("Editing people is not connected yet.");
        const previous = profileById.get(activeEditor.id);
        preserveInteractionMessageAfterProfileUpdateRef.current = Boolean(
          previous
          && isPerson(previous)
          && previous.reportsTo !== cleanDraft.reportsTo,
        );
        if (preserveInteractionMessageAfterProfileUpdateRef.current) {
          preserveArrangeAfterProfileUpdateRef.current = arrangeMode
            && document.fullscreenElement === rootRef.current;
        }
        await onUpdate(activeEditor.id, cleanDraft);
        if (
          previous
          && isPerson(previous)
          && previous.reportsTo !== cleanDraft.reportsTo
        ) {
          setRelationshipHistory((current) => [...current.slice(-19), {
            personId: previous.id,
            previousReportsTo: previous.reportsTo,
            nextReportsTo: cleanDraft.reportsTo,
          }]);
          animateCleanUp();
          setInteractionMessage(`Updated ${previous.name}'s reporting line.`);
        }
      }
      setEditor(null);
    } catch (caught) {
      preserveArrangeAfterProfileUpdateRef.current = false;
      preserveInteractionMessageAfterProfileUpdateRef.current = false;
      setError(
        caught instanceof Error ? caught.message : "Changes could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const rootClassName = [styles.organisation, className]
    .filter(Boolean)
    .join(" ");
  const worldStyle = {
    width: layout.width,
    height: layout.height,
    transform: `scale(${zoom})`,
  } as CSSProperties;
  const frameStyle = {
    width: layout.width * zoom,
    height: layout.height * zoom,
  } as CSSProperties;
  const linkSourceNode = linkGuide ? layoutNodesById.get(linkGuide.sourceId) : undefined;
  const linkSourceOffset = linkGuide ? manualOffsets[linkGuide.sourceId] ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  const linkStart = linkSourceNode
    ? {
        x: linkSourceNode.x + linkSourceOffset.x + linkSourceNode.width / 2,
        y: linkSourceNode.y + linkSourceOffset.y + linkSourceNode.height / 2,
      }
    : null;
  const linkTargetNode = dropTarget ? layoutNodesById.get(dropTarget.id) : undefined;
  const linkTargetOffset = dropTarget ? manualOffsets[dropTarget.id] ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  const linkEnd = linkTargetNode && dropTarget
    ? dropTarget.intent === "sibling"
      ? {
          x: linkTargetNode.x + linkTargetOffset.x - 22,
          y: linkTargetNode.y + linkTargetOffset.y + linkTargetNode.height / 2,
        }
      : dropTarget.intent === "target-reports-to-dragged"
        ? {
            x: linkTargetNode.x + linkTargetOffset.x + linkTargetNode.width / 2,
            y: linkTargetNode.y + linkTargetOffset.y - 22,
          }
        : {
            x: linkTargetNode.x + linkTargetOffset.x + linkTargetNode.width / 2,
            y: linkTargetNode.y + linkTargetOffset.y + linkTargetNode.height + 22,
          }
    : linkGuide?.pointer ?? null;
  const linkGuidePath = linkStart && linkEnd
    ? `M ${linkStart.x} ${linkStart.y} C ${(linkStart.x + linkEnd.x) / 2} ${linkStart.y}, ${(linkStart.x + linkEnd.x) / 2} ${linkEnd.y}, ${linkEnd.x} ${linkEnd.y}`
    : null;
  const linkForbiddenTargetIds = linkGuide
    ? getDescendantIds(linkGuide.sourceId, orderedProfiles).add(linkGuide.sourceId)
    : new Set<string>();

  return (
    <section aria-labelledby={titleId} className={rootClassName} ref={rootRef}>
      <h2 className={styles.srOnly} id={titleId}>Organisation</h2>

      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <label className={styles.search}>
            <Search aria-hidden="true" size={16} />
            <span className={styles.srOnly}>Search the organisation</span>
            <input
              aria-activedescendant={
                visibleSearchMatches[activeSearchResultIndex]
                  ? `${searchResultsId}-${visibleSearchMatches[activeSearchResultIndex].id}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls={searchResultsId}
              aria-expanded={searchOpen && Boolean(normalise(query))}
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveSearchIndex(0);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && visibleSearchMatches.length) {
                  event.preventDefault();
                  setActiveSearchIndex((current) =>
                    Math.min(current + 1, visibleSearchMatches.length - 1),
                  );
                } else if (event.key === "ArrowUp" && visibleSearchMatches.length) {
                  event.preventDefault();
                  setActiveSearchIndex((current) =>
                    Math.max(
                      Math.min(current, visibleSearchMatches.length - 1) - 1,
                      0,
                    ),
                  );
                } else if (
                  event.key === "Enter" &&
                  visibleSearchMatches[activeSearchResultIndex]
                ) {
                  event.preventDefault();
                  selectSearchResult(
                    visibleSearchMatches[activeSearchResultIndex].id,
                  );
                } else if (event.key === "Escape") {
                  setSearchOpen(false);
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search name or position"
              role="combobox"
              type="search"
              value={query}
            />
          </label>
          {searchOpen && normalise(query) ? (
            <div
              className={styles.searchResults}
              id={searchResultsId}
              role="listbox"
            >
              {visibleSearchMatches.length ? (
                visibleSearchMatches.map((profile, index) => (
                  <button
                    aria-selected={index === activeSearchResultIndex}
                    data-company={profile.company}
                    data-active={index === activeSearchResultIndex}
                    id={`${searchResultsId}-${profile.id}`}
                    key={profile.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveSearchIndex(index)}
                    onClick={() => selectSearchResult(profile.id)}
                    role="option"
                    type="button"
                  >
                    <span>{profile.name}</span>
                    <small>
                      {profile.position || companyLabels[profile.company]} · {companyLabels[profile.company]}
                    </small>
                  </button>
                ))
              ) : (
                <span className={styles.noResults}>No matching people</span>
              )}
            </div>
          ) : null}
        </div>

        <div className={styles.toolbarActions}>
          <div className={styles.headerActions}>
            <button
              aria-label="Export organisation as PDF"
              className={`${styles.secondaryAction} ${styles.iconAction}`}
              onClick={exportPdf}
              title="Export PDF"
              type="button"
            >
              <Download aria-hidden="true" size={16} />
              <span>Export PDF</span>
            </button>
            {canArrange ? (
              <button
                aria-pressed={arrangeMode}
                className={styles.arrangeAction}
                data-active={arrangeMode}
                disabled={Boolean(linkGuide)}
                onClick={toggleArrangeMode}
                title={linkGuide ? "Finish adding the current reporting line first" : undefined}
                type="button"
              >
                <GripVertical aria-hidden="true" size={16} />
                {arrangeMode ? "Finish arranging" : "Arrange"}
              </button>
            ) : null}
            {canUseLegacyTreeEditor ? (
              <button
                className={styles.primaryAction}
                disabled={!onCreate}
                onClick={() => openCreate()}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                Add person
              </button>
            ) : null}
          </div>

          <div
            className={styles.filterMenu}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !filterOpen) return;
              event.preventDefault();
              event.stopPropagation();
              setFilterOpen(false);
              filterButtonRef.current?.focus();
            }}
          >
            <button
              aria-label="Filter organisation"
              aria-expanded={filterOpen}
              aria-haspopup="menu"
              className={styles.filterButton}
              onClick={() => setFilterOpen((current) => !current)}
              ref={filterButtonRef}
              title="Filter"
              type="button"
            >
              <ListFilter aria-hidden="true" size={15} />
              <span>Filter</span>
              {companyFilter !== "all" ? <span className={styles.filterBadge}>1</span> : null}
            </button>
            {filterOpen ? (
              <div aria-label="Organisation filters" className={styles.filterCard} role="menu">
                <span className={styles.filterHeading}>Show teams</span>
                {([
                  ["all", "All"],
                  ["mam", "MAM"],
                  ["equipsy", "Equipsy"],
                  ["major", "Major"],
                  ["minor", "Minor"],
                  ["warehouse", "Warehouse"],
                ] as const).map(([filter, label]) => (
                  <button
                    aria-checked={companyFilter === filter}
                    className={styles.filterOption}
                    data-active={companyFilter === filter}
                    onClick={() => {
                      setCompanyFilter(filter);
                      setFilterOpen(false);
                      setFocusedRootId(null);
                      setQuery("");
                      setSelectedId(null);
                      workContactRequestRef.current += 1;
                      setWorkContact(null);
                      filterButtonRef.current?.focus();
                    }}
                    key={filter}
                    role="menuitemradio"
                    type="button"
                  >
                    <span>{label}</span>
                    {companyFilter === filter ? <Check aria-hidden="true" size={14} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {activeFocus ? (
        <div className={styles.focusBar} data-company={activeFocus.company}>
          <span>
            Viewing <strong>{activeFocus.name}&apos;s team</strong>
          </span>
          <button onClick={showFullOrganisation} type="button">
            Show full organisation
          </button>
        </div>
      ) : null}

      <span aria-live="polite" className={styles.srOnly}>
        {normalise(query)
          ? `${matchingIds.size} ${matchingIds.size === 1 ? "match" : "matches"}`
          : `${visiblePersonCount} ${visiblePersonCount === 1 ? "person" : "people"}`}
        {interactionMessage ? ` ${interactionMessage}` : ""}
      </span>

      {forest.length ? (
        <div className={styles.canvasShell}>
          <div className={styles.canvasDock}>
            <div className={styles.chartMeta}>
              <span>{visiblePersonCount} people</span>
              {arrangeMode ? <span>Arrange mode · drag to a card edge</span> : null}
              {linkGuide ? <span>Add line · choose a + or click blank space to cancel</span> : null}
            </div>

            <div aria-label="Chart view controls" className={styles.chartControls}>
              {canArrange ? (
                <button
                  aria-label="Clean up chart and restore the reporting layout"
                  className={styles.cleanUpControl}
                  disabled={!Object.keys(manualOffsets).length && !arrangeMode}
                  onClick={cleanUpChart}
                  title="Clean up chart"
                  type="button"
                >
                  <WandSparkles aria-hidden="true" size={15} />
                  <span>Clean up</span>
                </button>
              ) : null}
              {canUseRelationshipEditor ? (
                <button
                  aria-label="Undo last reporting-line change"
                  disabled={!relationshipHistory.length || saving}
                  onClick={() => void undoLastRelationship()}
                  title="Undo last reporting-line change"
                  type="button"
                >
                  <Undo2 aria-hidden="true" size={15} />
                </button>
              ) : null}
              <button
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={() =>
                  setZoom((current) =>
                    Math.max(MIN_ZOOM, Math.round((current - 0.1) * 100) / 100),
                  )
                }
                type="button"
              >
                <Minus aria-hidden="true" size={15} />
              </button>
              <span aria-label={`${Math.round(zoom * 100)} percent zoom`}>
                {Math.round(zoom * 100)}%
              </span>
              <button
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={() =>
                  setZoom((current) =>
                    Math.min(MAX_ZOOM, Math.round((current + 0.1) * 100) / 100),
                  )
                }
                type="button"
              >
                <Plus aria-hidden="true" size={15} />
              </button>
              <button
                aria-label="Fit chart to screen"
                className={styles.namedChartControl}
                onClick={fitChart}
                title="Fit chart to screen"
                type="button"
              >
                <LocateFixed aria-hidden="true" size={15} />
                <span>Fit</span>
              </button>
              <button aria-label="Reset chart view" onClick={resetView} type="button">
                <Focus aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={fullscreen ? "Exit full screen" : "Open full screen"}
                aria-pressed={fullscreen}
                onClick={toggleFullscreen}
                type="button"
              >
                {fullscreen ? (
                  <Minimize2 aria-hidden="true" size={15} />
                ) : (
                  <Maximize2 aria-hidden="true" size={15} />
                )}
              </button>
            </div>
          </div>

        <div
          aria-label="Organisation chart. Select a person for details. Use arrow keys to pan the chart."
          className={styles.treeViewport}
          data-arrange={arrangeMode}
          data-linking={linkGuide ? "true" : undefined}
          data-panning={panning}
          onKeyDown={handleViewportKeyDown}
          onLostPointerCapture={stopPan}
          onPointerCancel={stopPan}
          onPointerDown={startPan}
          onPointerMove={(event) => {
            movePan(event);
            moveLinkGuide(event);
          }}
          onPointerUp={stopPan}
          ref={viewportRef}
          tabIndex={0}
        >
          <div className={styles.desktopChart} style={frameStyle}>
            <div className={styles.chartWorld} data-arrange={arrangeMode} data-linking={linkGuide ? "true" : undefined} ref={chartWorldRef} style={worldStyle}>
              <svg
                aria-hidden={canUseRelationshipEditor ? undefined : "true"}
                aria-label={canUseRelationshipEditor ? "Editable reporting lines" : undefined}
                className={styles.connectors}
                data-editable={canUseRelationshipEditor ? "true" : "false"}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                width={layout.width}
              >
                <defs>
                  <marker
                    id={`${markerPrefix}-mam`}
                    markerHeight="6"
                    markerWidth="6"
                    orient="auto"
                    refX="5"
                    refY="3"
                    viewBox="0 0 6 6"
                  >
                    <path d="M 0 0 L 6 3 L 0 6 Z" fill="#ff751f" />
                  </marker>
                  <marker
                    id={`${markerPrefix}-equipsy`}
                    markerHeight="6"
                    markerWidth="6"
                    orient="auto"
                    refX="5"
                    refY="3"
                    viewBox="0 0 6 6"
                  >
                    <path d="M 0 0 L 6 3 L 0 6 Z" fill="#38b6ff" />
                  </marker>
                </defs>
                {layout.connectors.map((connector) => {
                  const active =
                    !selectedId ||
                    (relatedIds.has(connector.fromId) &&
                      relatedIds.has(connector.toId));
                  const child = profileById.get(connector.toId);
                  return (
                    <path
                      aria-label={
                        canUseRelationshipEditor
                          ? `Edit reporting line for ${child?.name ?? "this employee"}`
                          : undefined
                      }
                      className={styles.connector}
                      d={getConnectorPath(
                        connector,
                        layoutNodesById,
                        manualOffsets,
                      )}
                      data-active={active}
                      data-arranging={arranging}
                      data-company={connector.company}
                      data-editable={canUseRelationshipEditor ? "true" : "false"}
                      key={connector.id}
                      markerEnd={`url(#${markerPrefix}-${connector.company})`}
                      onClick={() => {
                        if (!canUseRelationshipEditor) return;
                        if (child) openReportingLinkEditor(child);
                      }}
                      onKeyDown={(event) => {
                        if (!canUseRelationshipEditor || (event.key !== "Enter" && event.key !== " ")) return;
                        event.preventDefault();
                        if (child) openReportingLinkEditor(child);
                      }}
                      role={canUseRelationshipEditor ? "button" : undefined}
                      tabIndex={canUseRelationshipEditor ? 0 : -1}
                    />
                  );
                })}
                {linkGuidePath ? <path className={styles.linkGuide} d={linkGuidePath} data-snapped={dropTarget ? "true" : "false"} /> : null}
              </svg>

              {layout.nodes.map((item) => {
                const collapsed = effectiveCollapsedIds.has(item.node.id);
                const related = relatedIds.has(item.node.id);
                const offset = manualOffsets[item.node.id] ?? { x: 0, y: 0 };
                const muted = Boolean(selectedId) && !related;
                const actionsOpen = openNodeActionsId === item.node.id;
                const canEditReportingLink =
                  isPerson(item.node) &&
                  canUseRelationshipEditor;
                const nextLayout = item.childrenLayout === "grouped"
                  ? "side-by-side"
                  : item.childrenLayout === "horizontal"
                    ? "one vertical stack"
                    : "same-title vertical groups";
                const orientationTooltip = item.hasChildren
                  ? `Switch ${item.node.name}'s reports to ${nextLayout} layout`
                  : `${item.node.name} has no direct reports to arrange`;
                const collapseTooltip = item.hasChildren
                  ? `${collapsed ? "Expand" : "Collapse"} ${item.node.name}'s team`
                  : `${item.node.name} has no direct reports to ${collapsed ? "expand" : "collapse"}`;
                const linkTooltip = canEditReportingLink
                  ? `Add or edit ${item.node.name}'s reporting line`
                  : "Only HR can edit reporting links";
                const disconnectTooltip = item.node.reportsTo
                  ? `Disconnect ${item.node.name} from its manager`
                  : `${item.node.name} is already top level`;
                return (
                  <div
                    className={styles.nodeWrap}
                    data-arrange={arrangeMode}
                    data-actions-open={actionsOpen}
                    data-dragging={draggingNodeId === item.node.id}
                    data-drop-intent={dropTarget?.id === item.node.id ? dropTarget.intent : undefined}
                    data-drop-target={dropTarget?.id === item.node.id ? "true" : undefined}
                    data-manual={Boolean(manualOffsets[item.node.id])}
                    data-muted={muted}
                    data-node-id={item.node.id}
                    data-link-source={linkGuide?.sourceId === item.node.id ? "true" : undefined}
                    data-selected={selectedId === item.node.id}
                    key={item.node.id}
                    onMouseLeave={() => {
                      setOpenNodeActionsId((current) =>
                        current === item.node.id ? null : current,
                      );
                    }}
                    style={{
                      left: item.x,
                      top: item.y,
                      width: item.width,
                      height: item.height,
                      transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
                    }}
                  >
                    <button
                      aria-current={selectedId === item.node.id ? "true" : undefined}
                      aria-label={`${item.node.name}, ${item.node.position || companyLabels[item.node.company]}, ${companyLabels[item.node.company]}`}
                      className={styles.personCard}
                      data-arrange={arrangeMode}
                      data-company={item.node.company}
                      data-highlighted={related}
                      data-matching={matchingIds.has(item.node.id)}
                      onClick={() => {
                        if (suppressCardClickRef.current) {
                          suppressCardClickRef.current = false;
                          return;
                        }
                        selectProfile(item.node.id);
                      }}
                      onPointerCancel={finishNodeDrag}
                      onPointerDown={(event) => startNodeDrag(event, item)}
                      onPointerMove={moveNodeDrag}
                      onPointerUp={finishNodeDrag}
                      onLostPointerCapture={finishNodeDrag}
                      title={
                        arrangeMode
                          ? canUseRelationshipEditor
                            ? "Drop beside a card for peers, above it to become its manager, or below it to report to it."
                            : "Drag to compare positions. Clean up restores the reporting layout."
                          : `${item.node.name}, ${item.node.position || companyLabels[item.node.company]}`
                      }
                      type="button"
                    >
                      <span className={styles.positionBand}>
                        {item.node.position || companyLabels[item.node.company]}
                        {canArrange && arrangeMode ? (
                          <GripVertical
                            aria-hidden="true"
                            className={styles.dragGrip}
                            size={13}
                          />
                        ) : null}
                      </span>
                      <span className={styles.nameBand}>{item.node.name}</span>
                      <span className={styles.srOnly}>
                        {companyLabels[item.node.company]}
                      </span>
                    </button>

                    {linkGuide && !linkForbiddenTargetIds.has(item.node.id) ? (
                      <div className={styles.linkTargets} aria-label={`Connect ${profileById.get(linkGuide.sourceId)?.name ?? "selected person"} with ${item.node.name}`}>
                        {([
                          ["target-reports-to-dragged", "top", `Make ${profileById.get(linkGuide.sourceId)?.name ?? "the selected person"} ${item.node.name}'s manager`],
                          ["sibling", "side", `Group ${profileById.get(linkGuide.sourceId)?.name ?? "the selected person"} with ${item.node.name} as a peer`],
                          ["report-to-target", "bottom", `Make ${profileById.get(linkGuide.sourceId)?.name ?? "the selected person"} report to ${item.node.name}`],
                        ] as const)
                          .filter(([intent]) => intent !== "target-reports-to-dragged" || isPerson(item.node))
                          .map(([intent, position, label]) => (
                          <button
                            aria-label={label}
                            className={styles.linkTarget}
                            data-active={dropTarget?.id === item.node.id && dropTarget.intent === intent ? "true" : undefined}
                            data-link-target={intent}
                            data-position={position}
                            key={intent}
                            onClick={(event) => {
                              event.stopPropagation();
                              void finishReportingLinkGuide({ id: item.node.id, intent });
                            }}
                            onFocus={() => setCurrentDropTarget({ id: item.node.id, intent })}
                            onPointerEnter={() => setCurrentDropTarget({ id: item.node.id, intent })}
                            type="button"
                          >
                            <Plus aria-hidden="true" size={14} />
                          </button>
                          ))}
                      </div>
                    ) : null}

                    <button
                      aria-controls={`node-actions-${item.node.id}`}
                      aria-expanded={actionsOpen}
                      aria-label={`Edit chart options for ${item.node.name}`}
                      className={styles.nodeActionTrigger}
                      data-company={item.node.company}
                      onClick={() => toggleNodeActions(item.node.id)}
                      title="Edit chart options"
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={14} />
                      <span className={styles.srOnly}>Edit chart options</span>
                    </button>

                    <div
                      aria-label={`Chart options for ${item.node.name}`}
                      className={styles.nodeActionMenu}
                      id={`node-actions-${item.node.id}`}
                      role="group"
                    >
                      <span
                        className={styles.nodeActionOptionWrap}
                        data-tooltip={orientationTooltip}
                      >
                        <button
                          aria-label={orientationTooltip}
                          className={styles.nodeActionOption}
                          data-company={item.node.company}
                          disabled={!item.hasChildren || !item.childrenLayout}
                          onClick={() => {
                            if (!item.childrenLayout) return;
                            toggleBranchLayout(
                              item.node.id,
                              item.childrenLayout,
                            );
                            setOpenNodeActionsId(null);
                          }}
                          title={orientationTooltip}
                          type="button"
                        >
                          {item.childrenLayout === "grouped" ? (
                            <Network aria-hidden="true" size={15} />
                          ) : item.childrenLayout === "vertical" ? (
                            <Rows3 aria-hidden="true" size={15} />
                          ) : (
                            <Columns3 aria-hidden="true" size={15} />
                          )}
                        </button>
                      </span>
                      <span
                        className={styles.nodeActionOptionWrap}
                        data-tooltip={collapseTooltip}
                      >
                        <button
                          aria-expanded={item.hasChildren ? !collapsed : undefined}
                          aria-label={collapseTooltip}
                          className={styles.nodeActionOption}
                          data-company={item.node.company}
                          disabled={!item.hasChildren}
                          onClick={() => {
                            toggleBranch(item.node.id);
                            setOpenNodeActionsId(null);
                          }}
                          title={collapseTooltip}
                          type="button"
                        >
                          {collapsed ? (
                            <ChevronRight aria-hidden="true" size={15} />
                          ) : (
                            <ChevronDown aria-hidden="true" size={15} />
                          )}
                        </button>
                      </span>
                      <span
                        className={styles.nodeActionOptionWrap}
                        data-tooltip={linkTooltip}
                      >
                        <button
                          aria-label={linkTooltip}
                          className={styles.nodeActionOption}
                          data-company={item.node.company}
                          disabled={!canEditReportingLink}
                          onClick={() => void startReportingLinkGuide(item.node)}
                          title={linkTooltip}
                          type="button"
                        >
                          <Link2 aria-hidden="true" size={15} />
                        </button>
                      </span>
                      <span
                        className={styles.nodeActionOptionWrap}
                        data-tooltip={disconnectTooltip}
                      >
                        <button
                          aria-label={disconnectTooltip}
                          className={styles.nodeActionOption}
                          data-company={item.node.company}
                          disabled={!canEditReportingLink || !item.node.reportsTo}
                          onClick={() => disconnectReportingLine(item.node)}
                          title={disconnectTooltip}
                          type="button"
                        >
                          <Link2Off aria-hidden="true" size={15} />
                        </button>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <ul aria-label="Organisation reporting tree" className={styles.mobileTree}>
            {forest.map((root) => (
              <MobileTreeBranch
                collapsedIds={effectiveCollapsedIds}
                highlightedIds={relatedIds}
                key={root.id}
                node={root}
                onSelect={selectProfile}
                onToggle={toggleBranch}
                selectedId={selectedId}
              />
            ))}
          </ul>
        </div>
        </div>
      ) : (
        <div className={styles.emptyState}>
          {profiles.length ? (
            <Search aria-hidden="true" size={22} />
          ) : (
            <Network aria-hidden="true" size={22} />
          )}
          <strong>{profiles.length ? "No matching people" : "No people yet"}</strong>
          <span>
            {profiles.length
              ? "Try another search or company."
              : "Add the first person to start the tree."}
          </span>
        </div>
      )}

      {selectedProfile ? (
        <div className={styles.inspectorLayer}>
          {mobileInspectorOpen ? <button aria-label="Close person details" className={styles.inspectorBackdrop} onClick={closeInspector} type="button" /> : null}
          <aside
            aria-label={mobileInspectorOpen ? undefined : `${selectedProfile.name} details`}
            aria-labelledby={mobileInspectorOpen ? inspectorTitleId : undefined}
            aria-modal={mobileInspectorOpen || undefined}
            className={styles.inspector}
            ref={inspectorDialogRef}
            role={mobileInspectorOpen ? "dialog" : undefined}
            tabIndex={mobileInspectorOpen ? -1 : undefined}
          >
            <header className={styles.inspectorHeader} data-company={selectedProfile.company}>
              <div>
                <span>{selectedProfile.position || companyLabels[selectedProfile.company]}</span>
                <strong id={inspectorTitleId}>{selectedProfile.name}</strong>
              </div>
              <button
                aria-label="Close person details"
                onClick={closeInspector}
                ref={inspectorCloseButtonRef}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </header>

            <div className={styles.inspectorBody}>
              <dl className={styles.personFacts}>
                <div>
                  <dt>Company</dt>
                  <dd>{companyLabels[selectedProfile.company]}</dd>
                </div>
                <div>
                  <dt>Team below</dt>
                  <dd>{selectedTeamSize}</dd>
                </div>
              </dl>

              {isPerson(selectedProfile) ? (
                <section className={styles.relationships}>
                  <span>Work email</span>
                  {workContact?.personId === selectedProfile.id
                    && workContact.state === "loading" ? (
                      <p aria-live="polite">Loading work contact…</p>
                    ) : workContact?.personId === selectedProfile.id
                      && workContact.state === "ready"
                      && workContact.email ? (
                        <a
                          className={styles.workEmail}
                          href={`mailto:${encodeURIComponent(workContact.email)}`}
                        >
                          <Mail aria-hidden="true" size={15} />
                          <strong>{workContact.email}</strong>
                        </a>
                      ) : workContact?.personId === selectedProfile.id
                        && workContact.state === "error" ? (
                          <button type="button" onClick={() => requestWorkContact(selectedProfile.id)}>
                            <strong>Retry work email</strong>
                            <small>The previous request did not complete.</small>
                          </button>
                        ) : onRequestWorkEmail ? (
                          <p>Work email not listed.</p>
                        ) : (
                          <p>Work contact is unavailable.</p>
                        )}
                </section>
              ) : null}

              <section className={styles.relationships}>
                <span>Reports to</span>
                {selectedManager ? (
                  <button onClick={() => selectProfile(selectedManager.id)} type="button">
                    <strong>{selectedManager.name}</strong>
                    <small>{selectedManager.position || companyLabels[selectedManager.company]}</small>
                  </button>
                ) : (
                  <p>Top level</p>
                )}
              </section>

              <section className={styles.relationships}>
                <span>Direct reports · {selectedReports.length}</span>
                {selectedReports.length ? (
                  <div className={styles.reportList}>
                    {selectedReports.map((report) => (
                      <button key={report.id} onClick={() => selectProfile(report.id)} type="button">
                        <strong>{report.name}</strong>
                        <small>{report.position || companyLabels[report.company]}</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p>No direct reports</p>
                )}
              </section>

            </div>

            <footer className={styles.inspectorActions}>
              <button
                className={styles.secondaryAction}
                onClick={() =>
                  focusedRootId === selectedProfile.id
                    ? showFullOrganisation()
                    : focusTeam(selectedProfile.id)
                }
                type="button"
              >
                <Focus aria-hidden="true" size={15} />
                {focusedRootId === selectedProfile.id ? "Show all" : "View this team"}
              </button>
              {onOpenEmployeeRecord && isPerson(selectedProfile) ? (
                <button
                  className={styles.secondaryAction}
                  onClick={() => onOpenEmployeeRecord(selectedProfile.id)}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={15} />
                  Open HR record
                </button>
              ) : null}
              {canUseLegacyTreeEditor && isPerson(selectedProfile) ? (
                <>
                  <button
                    className={styles.secondaryAction}
                    disabled={!onUpdate}
                    onClick={() => openUpdate(selectedProfile)}
                    type="button"
                  >
                    <Pencil aria-hidden="true" size={15} />
                    Edit
                  </button>
                  <button
                    className={styles.primaryAction}
                    disabled={!onCreate}
                    onClick={() => openCreate(selectedProfile.id, selectedProfile.company)}
                    type="button"
                  >
                    <UserPlus aria-hidden="true" size={15} />
                    Add report
                  </button>
                </>
              ) : null}
            </footer>
          </aside>
        </div>
      ) : null}

      {pendingDisconnect ? (
        <div
          aria-labelledby={`${titleId}-disconnect-title`}
          aria-modal="true"
          className={styles.confirmationLayer}
          ref={disconnectDialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <button
            aria-label="Cancel disconnect confirmation"
            className={styles.confirmationBackdrop}
            disabled={saving}
            onClick={closeDisconnect}
            tabIndex={-1}
            type="button"
          />
          <div className={styles.confirmationCard}>
            <span className={styles.eyebrow}>Reporting line</span>
            <h3 id={`${titleId}-disconnect-title`}>Disconnect this link?</h3>
            <p>
              {pendingDisconnect.name} will become a top-level person until a new manager is selected.
            </p>
            <div className={styles.confirmationActions}>
              <button
                className={styles.secondaryAction}
                disabled={saving}
                onClick={closeDisconnect}
                ref={disconnectKeepButtonRef}
                type="button"
              >
                Keep link
              </button>
              <button
                className={styles.primaryAction}
                disabled={saving}
                onClick={confirmDisconnect}
                type="button"
              >
                {saving ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activeEditor ? (
        <div className={styles.drawerLayer}>
          <button
            aria-label="Close person editor"
            className={styles.backdrop}
            disabled={saving}
            onClick={closeEditor}
            tabIndex={-1}
            type="button"
          />
          <aside
            aria-labelledby={`${titleId}-editor`}
            aria-modal="true"
            className={styles.drawer}
            ref={editorDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className={styles.drawerHeader}>
              <div>

                <h3 id={`${titleId}-editor`}>
                  {activeEditor.mode === "create"
                    ? "Add person"
                    : canUseLegacyTreeEditor
                      ? "Edit person"
                      : "Edit reporting line"}
                </h3>
              </div>
              <button
                aria-label="Close"
                disabled={saving}
                onClick={closeEditor}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </header>

            <form className={styles.form} onSubmit={savePerson}>
              {canUseLegacyTreeEditor ? (
                <>
                  <label>
                    <span>Name</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      required
                      value={draft.name}
                    />
                  </label>

                  <label>
                    <span>Position</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setDraft((current) => ({ ...current, position: event.target.value }))}
                      required
                      value={draft.position}
                    />
                  </label>

                  <label>
                    <span>Company</span>
                    <select
                      onChange={(event) => setDraft((current) => ({ ...current, company: event.target.value as OrganisationCompany }))}
                      value={draft.company}
                    >
                      <option value="mam">MAM</option>
                      <option value="equipsy">Equipsy</option>
                    </select>
                  </label>
                </>
              ) : null}

              <label>
                <span>Reports to</span>
                <select
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      reportsTo: event.target.value || null,
                    }))
                  }
                  value={draft.reportsTo ?? ""}
                >
                  <option value="">No manager — top level</option>
                  {managerOptions.map((profile) => {
                    const key = `${profile.name}\u0000${profile.position}\u0000${profile.company}`;
                    const duplicate = (duplicateManagerLabels.get(key) ?? 0) > 1;
                    const position = profile.position ? ` — ${profile.position}` : "";
                    const duplicateIndex = duplicate
                      ? managerOptions.filter((candidate) => (
                        candidate.name === profile.name
                        && candidate.position === profile.position
                        && candidate.company === profile.company
                      )).findIndex((candidate) => candidate.id === profile.id) + 1
                      : null;
                    const identifier = duplicateIndex ? ` · ${duplicateIndex}` : "";
                    return (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                        {position} · {companyLabels[profile.company]}
                        {identifier}
                      </option>
                    );
                  })}
                </select>
              </label>

              {error ? (
                <p aria-live="assertive" className={styles.formError}>
                  {error}
                </p>
              ) : null}

              <footer className={styles.formActions}>
                <button
                  className={styles.cancelAction}
                  disabled={saving}
                  onClick={closeEditor}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className={styles.saveAction}
                  disabled={
                    saving ||
                    (activeEditor.mode === "create" ? !onCreate : !onUpdate)
                  }
                  type="submit"
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
