"use client";

import {
  ChevronDown,
  ChevronRight,
  Focus,
  GripVertical,
  LocateFixed,
  Mail,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Pencil,
  Plus,
  Search,
  UnfoldVertical,
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
  /**
   * Opens the HR-only record editor without exposing private fields in the
   * tree. A manager ID preselects a proposed reporting line; the HR editor
   * still requires an explicit Save before the live hierarchy changes.
   */
  onOpenEmployeeRecord?: (
    personId: string,
    managerId?: string | null,
  ) => void;
  /** Loads only the selected person's employee-visible work contact on demand. */
  onRequestWorkEmail?: (personId: string) => Promise<string | null>;
  className?: string;
};

type CompanyFilter = "all" | OrganisationCompany;
type TreeNode = OrganisationPerson & { children: TreeNode[] };
type EditorState =
  | { mode: "create" }
  | { mode: "update"; id: string }
  | null;
type LayoutMode = "leaf" | "standard" | "stack" | "grid";
type MeasuredNode = {
  node: TreeNode;
  children: MeasuredNode[];
  width: number;
  height: number;
  mode: LayoutMode;
  gridColumns?: number;
  depth: number;
};
type PositionedNode = {
  node: TreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  hasChildren: boolean;
  descendantCount: number;
};
type Connector = {
  id: string;
  fromId: string;
  toId: string;
  sourceCompany: OrganisationCompany;
  path: string;
};
type NodeOffset = { x: number; y: number };
type NodeDragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: NodeOffset;
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

const CARD_WIDTH = 188;
const CARD_HEIGHT = 64;
const HORIZONTAL_GAP = 30;
const VERTICAL_GAP = 68;
const STACK_GAP = 13;
const STACK_BUS = 24;
const ROOT_GAP = 48;
const LEADERSHIP_GAP = 82;
const ROOT_COLUMNS = 4;
const CANVAS_MARGIN = 54;
const MAX_ROW_WIDTH = CARD_WIDTH * 4 + HORIZONTAL_GAP * 3;
const DEFAULT_ZOOM = 0.92;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 1.35;
const DRAG_THRESHOLD = 5;
const ARRANGE_DURATION = 260;
const CHART_TOP_INSET = 76;

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

function isExternalReportingGroup(node: TreeNode) {
  return (
    node.kind === "org_unit" &&
    normalise(node.name) === "external reporting group"
  );
}

function leadershipRank(node: TreeNode) {
  const position = normalise(node.position);
  if (position === "director") return 0;
  if (position === "cfo") return 1;
  if (position.includes("director")) return 2;
  return 3;
}

function isLeadershipNode(node: TreeNode) {
  // Keep the two MAM executive roots prominent. Other company directors are
  // still shown in their actual branch rather than being promoted beside them.
  return (
    isPerson(node) &&
    node.company === "mam" &&
    leadershipRank(node) < 2
  );
}

/**
 * External reporting groups deliberately contain no manager identity. They are
 * useful for access control, but they should not become the visual head of the
 * organisation chart. This creates a presentation-only hierarchy: leadership
 * is promoted for an at-a-glance overview while the stored reporting links and
 * HR editor remain untouched.
 */
function buildPresentationForest(forest: TreeNode[]) {
  const leadership: TreeNode[] = [];

  const visit = (node: TreeNode, beneathExternalGroup = false): TreeNode[] => {
    const externalGroup = isExternalReportingGroup(node);
    const children = node.children.flatMap((child) =>
      visit(child, beneathExternalGroup || externalGroup),
    );
    const nextNode = { ...node, children };

    if (externalGroup) return children;

    if (beneathExternalGroup && isLeadershipNode(nextNode)) {
      leadership.push(nextNode);
      return [];
    }

    return [nextNode];
  };

  const remaining = forest.flatMap((node) => visit(node));
  const leadershipIds = new Set(leadership.map((node) => node.id));

  const sortedLeadership = [...leadership].sort((left, right) => {
    const rank = leadershipRank(left) - leadershipRank(right);
    if (rank) return rank;
    const order =
      (left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
    if (order) return order;
    return left.name.localeCompare(right.name);
  });

  return [
    ...sortedLeadership,
    ...sortPeople(remaining.filter((node) => !leadershipIds.has(node.id))),
  ];
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
): MeasuredNode {
  const children = collapsedIds.has(node.id)
    ? []
    : node.children.map((child) => measureNode(child, collapsedIds, depth + 1));

  if (!children.length) {
    return {
      node,
      children,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      mode: "leaf",
      depth,
    };
  }

  const allLeaves = children.every((child) => child.children.length === 0);
  const childrenWidth =
    children.reduce((width, child) => width + child.width, 0) +
    HORIZONTAL_GAP * (children.length - 1);
  const gridColumns = Math.min(2, children.length);
  const grid = children.length >= 3 && childrenWidth > MAX_ROW_WIDTH;

  if (grid) {
    const columnWidths = Array.from({ length: gridColumns }, () => CARD_WIDTH);
    const columnHeights = Array.from({ length: gridColumns }, () => 0);

    for (const child of children) {
      const column = columnHeights.reduce(
        (shortestColumn, height, index) =>
          height < columnHeights[shortestColumn] ? index : shortestColumn,
        0,
      );
      columnWidths[column] = Math.max(columnWidths[column], child.width);
      columnHeights[column] += child.height + STACK_GAP;
    }

    return {
      node,
      children,
      width:
        Math.max(CARD_WIDTH, columnWidths.reduce((width, value) => width + value, 0) +
          HORIZONTAL_GAP * (gridColumns - 1)),
      height:
        CARD_HEIGHT +
        VERTICAL_GAP +
        Math.max(...columnHeights.map((height) => Math.max(0, height - STACK_GAP))),
      mode: "grid",
      gridColumns,
      depth,
    };
  }

  const stack =
    allLeaves && (children.length >= 3 || (depth >= 2 && children.length >= 2));
  if (stack) {
    const childHeight =
      children.reduce((height, child) => height + child.height, 0) +
      (children.length - 1) * STACK_GAP;
    return {
      node,
      children,
      width: Math.max(
        CARD_WIDTH + STACK_BUS,
        ...children.map((child) => child.width),
      ),
      height: CARD_HEIGHT + VERTICAL_GAP + childHeight,
      mode: "stack",
      depth,
    };
  }

  return {
    node,
    children,
    width: Math.max(CARD_WIDTH, childrenWidth),
    height:
      CARD_HEIGHT +
      VERTICAL_GAP +
      Math.max(...children.map((child) => child.height)),
    mode: "standard",
    depth,
  };
}

function layoutForest(
  forest: TreeNode[],
  collapsedIds: Set<string>,
): ChartLayout {
  const boxes = forest.map((root) => measureNode(root, collapsedIds, 0));
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
      descendantCount: countTreeDescendants(box.node),
    });

    if (!box.children.length) return;

    const parentCenter = x + CARD_WIDTH / 2;
    const parentBottom = y + CARD_HEIGHT;

    if (box.mode === "grid") {
      const gridColumns = box.gridColumns ?? 2;
      const columnWidths = Array.from({ length: gridColumns }, () => CARD_WIDTH);
      const columnHeights = Array.from({ length: gridColumns }, () => 0);

      for (const child of box.children) {
        const column = columnHeights.reduce(
          (shortestColumn, height, index) =>
            height < columnHeights[shortestColumn] ? index : shortestColumn,
          0,
        );
        columnWidths[column] = Math.max(columnWidths[column], child.width);
        columnHeights[column] += child.height + STACK_GAP;
      }

      const columnsWidth =
        columnWidths.reduce((width, value) => width + value, 0) +
        HORIZONTAL_GAP * (gridColumns - 1);
      const firstColumnLeft = left + (box.width - columnsWidth) / 2;
      const columnOffsets = columnWidths.reduce<number[]>((offsets, width, index) => {
        offsets.push(
          index === 0
            ? 0
            : offsets[index - 1] + columnWidths[index - 1] + HORIZONTAL_GAP,
        );
        return offsets;
      }, []);
      const placedColumnHeights = Array.from({ length: gridColumns }, () => 0);
      const childRowTop = top + CARD_HEIGHT + VERTICAL_GAP;
      const middleY = parentBottom + VERTICAL_GAP / 2;

      for (const child of box.children) {
        const column = placedColumnHeights.reduce(
          (shortestColumn, height, index) =>
            height < placedColumnHeights[shortestColumn]
              ? index
              : shortestColumn,
          0,
        );
        const childTop = childRowTop + placedColumnHeights[column];
        const childLeft =
          firstColumnLeft +
          columnOffsets[column] +
          (columnWidths[column] - child.width) / 2;
        const childCenter = childLeft + child.width / 2;
        place(child, childLeft, childTop);
        connectors.push({
          id: `${box.node.id}-${child.node.id}`,
          fromId: box.node.id,
          toId: child.node.id,
          sourceCompany: box.node.company,
          path: `M ${parentCenter} ${parentBottom} V ${middleY} H ${childCenter} V ${childTop}`,
        });
        placedColumnHeights[column] += child.height + STACK_GAP;
      }
      return;
    }

    if (box.mode === "stack") {
      const childX = x;
      const busX = childX - STACK_BUS;
      const busTop = parentBottom + VERTICAL_GAP / 2;
      let childTop = top + CARD_HEIGHT + VERTICAL_GAP;

      box.children.forEach((child) => {
        const childMiddle = childTop + CARD_HEIGHT / 2;
        place(child, childX - (child.width - CARD_WIDTH) / 2, childTop);
        connectors.push({
          id: `${box.node.id}-${child.node.id}`,
          fromId: box.node.id,
          toId: child.node.id,
          sourceCompany: box.node.company,
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
        sourceCompany: box.node.company,
        path:
          box.children.length === 1
            ? `M ${parentCenter} ${parentBottom} V ${childTop}`
            : `M ${parentCenter} ${parentBottom} V ${middleY} H ${childCenter} V ${childTop}`,
      });
      cursor += child.width + HORIZONTAL_GAP;
    });
  };

  const leadership = boxes.filter((box) => isLeadershipNode(box.node));
  const operationalRoots = boxes.filter((box) => !isLeadershipNode(box.node));
  const leadershipWidth = leadership.length
    ? leadership.reduce((width, box) => width + box.width, 0) +
      (leadership.length - 1) * ROOT_GAP
    : 0;
  const operationalColumnCount = Math.min(ROOT_COLUMNS, operationalRoots.length);
  const operationalColumnWidth = operationalRoots.length
    ? Math.max(...operationalRoots.map((box) => box.width))
    : CARD_WIDTH;
  const operationalWidth = operationalRoots.length
    ? operationalColumnCount * operationalColumnWidth +
      (operationalColumnCount - 1) * ROOT_GAP
    : 0;
  const contentWidth = Math.max(CARD_WIDTH, leadershipWidth, operationalWidth);
  const leadershipHeight = leadership.length
    ? Math.max(...leadership.map((box) => box.height))
    : 0;

  let leadershipCursor =
    CANVAS_MARGIN + Math.max(0, (contentWidth - leadershipWidth) / 2);
  for (const box of leadership) {
    place(box, leadershipCursor, CANVAS_MARGIN);
    leadershipCursor += box.width + ROOT_GAP;
  }

  const operationalTop =
    CANVAS_MARGIN + (leadership.length ? leadershipHeight + LEADERSHIP_GAP : 0);
  const columnHeights = Array.from(
    { length: operationalColumnCount },
    () => 0,
  );
  for (const box of operationalRoots) {
    const column = columnHeights.reduce(
      (shortestColumn, height, index) =>
        height < columnHeights[shortestColumn] ? index : shortestColumn,
      0,
    );
    const left =
      CANVAS_MARGIN +
      Math.max(0, (contentWidth - operationalWidth) / 2) +
      column * (operationalColumnWidth + ROOT_GAP) +
      (operationalColumnWidth - box.width) / 2;
    place(box, left, operationalTop + columnHeights[column]);
    columnHeights[column] += box.height + ROOT_GAP;
  }

  const operationalHeight = operationalRoots.length
    ? Math.max(...columnHeights) - ROOT_GAP
    : 0;
  const contentHeight = Math.max(
    CARD_HEIGHT,
    leadershipHeight,
    (leadership.length ? leadershipHeight + LEADERSHIP_GAP : 0) +
      operationalHeight,
  );

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
  const [companyFilter, setCompanyFilter] = useState<CompanyFilter>("all");
  const [focusedRootId, setFocusedRootId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [viewMode, setViewMode] = useState<"fit" | "manual">("fit");
  const [panning, setPanning] = useState(false);
  const [arrangeMode, setArrangeMode] = useState(false);
  const [manualOffsets, setManualOffsets] = useState<Record<string, NodeOffset>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [interactionMessage, setInteractionMessage] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
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
  const descriptionId = useId();
  const searchResultsId = useId();
  const markerPrefix = useId().replaceAll(":", "");
  const chartShellRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const suppressCardClickRef = useRef(false);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const pendingOffsetRef = useRef<{ id: string; offset: NodeOffset } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const arrangeTimerRef = useRef<number | null>(null);
  const workContactRequestRef = useRef(0);
  const autoFitFrameRef = useRef<number | null>(null);
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
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editor && !saving) setEditor(null);
      else if (selectedId) {
        workContactRequestRef.current += 1;
        setWorkContact(null);
        setSelectedId(null);
      }
    };
    const handleFullscreen = () => {
      setFullscreen(document.fullscreenElement === chartShellRef.current);
    };

    window.addEventListener("keydown", handleKeydown);
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("fullscreenchange", handleFullscreen);
    };
  }, [editor, saving, selectedId]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
      if (arrangeTimerRef.current !== null) {
        window.clearTimeout(arrangeTimerRef.current);
      }
      if (autoFitFrameRef.current !== null) {
        window.cancelAnimationFrame(autoFitFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setManualOffsets({});
      setArrangeMode(false);
      setDraggingNodeId(null);
      setDropTargetId(null);
      setInteractionMessage("");
    }, 0);

    return () => window.clearTimeout(timer);
  }, [profileLayoutKey]);

  const orderedProfiles = useMemo(() => sortPeople(profiles), [profiles]);
  const profileById = useMemo(
    () => new Map(orderedProfiles.map((profile) => [profile.id, profile])),
    [orderedProfiles],
  );

  const companyScopeIds = useMemo(() => {
    const ids = new Set(
      orderedProfiles
        .filter(
          (profile) =>
            companyFilter === "all" || profile.company === companyFilter,
        )
        .map((profile) => profile.id),
    );
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
  const presentationForest = useMemo(
    () => buildPresentationForest(forest),
    [forest],
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
    () => layoutForest(presentationForest, effectiveCollapsedIds),
    [effectiveCollapsedIds, presentationForest],
  );
  const layoutNodesById = useMemo(
    () => new Map(layout.nodes.map((item) => [item.node.id, item])),
    [layout.nodes],
  );

  const selectedProfile = selectedId ? profileById.get(selectedId) : undefined;
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

  const dismissInspector = () => {
    workContactRequestRef.current += 1;
    setWorkContact(null);
    setSelectedId(null);
  };

  const openEmployeeRecord = (personId: string, managerId?: string | null) => {
    dismissInspector();
    onOpenEmployeeRecord?.(personId, managerId);
  };

  const activeEditor =
    canUseLegacyTreeEditor &&
    (editor?.mode === "create" ||
      (editor?.mode === "update" &&
        profiles.some(
          (profile) => profile.id === editor.id && isPerson(profile),
        )))
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

  const branchIds = useMemo(
    () =>
      new Set(
        layout.nodes
          .filter((node) => node.hasChildren)
          .map((node) => node.node.id),
      ),
    [layout.nodes],
  );

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

  const fitChart = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      const nextZoom = clamp(
        Math.min(
          1,
          (viewport.clientWidth - 32) / layout.width,
          (viewport.clientHeight - CHART_TOP_INSET - 28) / layout.height,
        ),
        MIN_ZOOM,
        MAX_ZOOM,
      );

      setZoom(nextZoom);
      window.requestAnimationFrame(() => {
        const currentViewport = viewportRef.current;
        if (!currentViewport) return;
        currentViewport.scrollTo({
          behavior,
          left: Math.max(
            0,
            (layout.width * nextZoom - currentViewport.clientWidth) / 2,
          ),
          top: 0,
        });
      });
    },
    [layout.height, layout.width],
  );

  useEffect(() => {
    if (viewMode !== "fit" || !presentationForest.length) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const scheduleFit = () => {
      if (autoFitFrameRef.current !== null) {
        window.cancelAnimationFrame(autoFitFrameRef.current);
      }
      autoFitFrameRef.current = window.requestAnimationFrame(() => {
        autoFitFrameRef.current = null;
        fitChart("auto");
      });
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(viewport);
    scheduleFit();

    return () => {
      observer.disconnect();
      if (autoFitFrameRef.current !== null) {
        window.cancelAnimationFrame(autoFitFrameRef.current);
        autoFitFrameRef.current = null;
      }
    };
  }, [fitChart, presentationForest.length, viewMode]);

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
    setSelectedId(id);
    requestWorkContact(id);
    setSearchOpen(false);
    centerNode(id, visibleIds.has(id) ? 30 : 100);
  };

  const selectSearchResult = (id: string) => {
    expandAncestorBranches(id);
    setQuery("");
    setSearchOpen(false);
    setSelectedId(id);
    requestWorkContact(id);
    centerNode(id, 100);
  };

  const focusTeam = (id: string) => {
    setViewMode("fit");
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
    setViewMode("fit");
    setFocusedRootId(null);
    setCompanyFilter("all");
    setQuery("");
    if (selectedId) centerNode(selectedId, 100);
  };

  const toggleBranch = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllBranches = () => {
    setViewMode("fit");
    const allCollapsed =
      branchIds.size > 0 &&
      [...branchIds].every((id) => effectiveCollapsedIds.has(id));
    setCollapsedIds(allCollapsed ? new Set() : new Set(branchIds));
    setInteractionMessage(
      allCollapsed
        ? "All reporting lines expanded."
        : "All reporting lines collapsed.",
    );
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

  const toggleArrangeMode = () => {
    if (!canArrange) return;
    if (arrangeMode) {
      setArrangeMode(false);
      setInteractionMessage(
        "Arrange mode off. Local positions remain until you clean up the chart or refresh.",
      );
      return;
    }

    workContactRequestRef.current += 1;
    setWorkContact(null);
    setSelectedId(null);
    setArrangeMode(true);
    setInteractionMessage(
      "Arrange mode on. Drop a person on another person to propose a new manager, or drop on empty space to compare positions.",
    );
  };

  const resetView = () => {
    setViewMode("fit");
    setFocusedRootId(null);
    setCompanyFilter("all");
    setQuery("");
    setSelectedId(null);
    workContactRequestRef.current += 1;
    setWorkContact(null);
    setCollapsedIds(new Set());
    setArrangeMode(false);
    setManualOffsets({});
    setInteractionMessage("");
  };

  const toggleFullscreen = async () => {
    const chartShell = chartShellRef.current;
    if (!chartShell) return;
    if (document.fullscreenElement === chartShell) {
      await document.exitFullscreen();
    } else {
      await chartShell.requestFullscreen();
    }
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, label, aside")) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    setViewMode("manual");
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
    setViewMode("manual");
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

  const startNodeDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    node: PositionedNode,
  ) => {
    if (!canArrange || !arrangeMode || event.button !== 0) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragRef.current = {
      id: node.node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: manualOffsets[node.node.id] ?? { x: 0, y: 0 },
      node,
      moved: false,
    };
    setDraggingNodeId(node.node.id);
  };

  const getDropTarget = (
    sourceId: string,
    clientX: number,
    clientY: number,
  ) => {
    if (!onOpenEmployeeRecord) return null;
    const element = document.elementFromPoint(clientX, clientY);
    const targetId = element
      ?.closest<HTMLElement>("[data-node-id]")
      ?.dataset.nodeId;
    if (!targetId || targetId === sourceId) return null;

    const target = profileById.get(targetId);
    if (!target || !isPerson(target) || target.isActive === false) return null;
    if (getDescendantIds(sourceId, orderedProfiles).has(targetId)) return null;
    return target;
  };

  const moveNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = (event.clientX - drag.startX) / zoom;
    const deltaY = (event.clientY - drag.startY) / zoom;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;

    drag.moved = true;
    event.preventDefault();
    event.stopPropagation();
    const target = getDropTarget(drag.id, event.clientX, event.clientY);
    setDropTargetId((current) => (current === target?.id ? current : target?.id ?? null));
    scheduleOffset(drag.id, {
      x: clamp(
        drag.startOffset.x + deltaX,
        CANVAS_MARGIN - drag.node.x,
        layout.width - CANVAS_MARGIN - drag.node.width - drag.node.x,
      ),
      y: clamp(
        drag.startOffset.y + deltaY,
        CANVAS_MARGIN - drag.node.y,
        layout.height - CANVAS_MARGIN - drag.node.height - drag.node.y,
      ),
    });
  };

  const finishNodeDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
      flushPendingOffset();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const dropTarget = drag.moved && event.type !== "pointercancel"
      ? getDropTarget(drag.id, event.clientX, event.clientY)
      : null;
    nodeDragRef.current = null;
    setDraggingNodeId(null);
    setDropTargetId(null);
    if (drag.moved) {
      suppressCardClickRef.current = true;
      window.setTimeout(() => {
        suppressCardClickRef.current = false;
      }, 0);

      if (dropTarget) {
        setManualOffsets((current) => {
          const next = { ...current };
          delete next[drag.id];
          return next;
        });
        setInteractionMessage(
          `${drag.node.node.name} will report to ${dropTarget.name} once you save the HR record.`,
        );
        openEmployeeRecord(drag.id, dropTarget.id);
        return;
      }

      setInteractionMessage(
        `${drag.node.node.name} moved locally. Clean up restores the reporting layout.`,
      );
      return;
    }

    if (event.type !== "pointercancel") {
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
      companyFilter === "all" ? "mam" : companyFilter,
  ) => {
    if (!canUseLegacyTreeEditor) return;
    setDraft({ ...emptyDraft, company, reportsTo });
    setError("");
    setEditor({ mode: "create" });
  };

  const openUpdate = (profile: OrganisationPerson) => {
    if (!canUseLegacyTreeEditor || !isPerson(profile)) return;
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

  const closeEditor = () => {
    if (!saving) setEditor(null);
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
        await onUpdate(activeEditor.id, cleanDraft);
      }
      setEditor(null);
    } catch (caught) {
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

  return (
    <section aria-labelledby={titleId} className={rootClassName}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>People</span>
          <h2 id={titleId}>Organisation</h2>
          <p>Select a person to view their reporting line and work contact.</p>
        </div>

        {canArrange || canUseLegacyTreeEditor ? (
          <div className={styles.headerActions}>
            {canArrange ? (
              <button
                aria-pressed={arrangeMode}
                className={styles.arrangeAction}
                data-active={arrangeMode}
                onClick={toggleArrangeMode}
                type="button"
              >
                <GripVertical aria-hidden="true" size={16} />
                {arrangeMode ? "Finish arranging" : "Arrange & link"}
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
        ) : null}
      </header>

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

        <div aria-label="Filter by company" className={styles.filters}>
          {(["all", "mam", "equipsy"] as const).map((filter) => (
            <button
              aria-pressed={companyFilter === filter}
              data-active={companyFilter === filter}
              data-company={filter}
              key={filter}
              onClick={() => {
                setCompanyFilter(filter);
                setFocusedRootId(null);
                setQuery("");
                setSelectedId(null);
                setViewMode("fit");
                workContactRequestRef.current += 1;
                setWorkContact(null);
              }}
              type="button"
            >
              {filter === "all" ? "All" : companyLabels[filter]}
            </button>
          ))}
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

      {presentationForest.length ? (
        <div className={styles.chartShell} ref={chartShellRef}>
          <div className={styles.chartChrome}>
          <div className={styles.chartMeta}>
            <span>{visiblePersonCount} people</span>
            <span>
              {arrangeMode
                ? "Arrange mode · drag a person"
                : "Drag empty space to pan"}
            </span>
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
            <button
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => {
                setViewMode("manual");
                setZoom((current) =>
                  Math.max(MIN_ZOOM, Math.round((current - 0.1) * 100) / 100),
                );
              }}
              title="Zoom out"
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
              onClick={() => {
                setViewMode("manual");
                setZoom((current) =>
                  Math.min(MAX_ZOOM, Math.round((current + 0.1) * 100) / 100),
                );
              }}
              title="Zoom in"
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
            </button>
            <button
              aria-label="Fit chart to screen"
              className={styles.namedChartControl}
              onClick={() => {
                setViewMode("fit");
                fitChart(getScrollBehavior());
              }}
              title="Fit chart to screen"
              type="button"
            >
              <LocateFixed aria-hidden="true" size={15} />
              <span>Fit</span>
            </button>
            <button
              aria-label="Expand or collapse all reporting lines"
              onClick={toggleAllBranches}
              title="Expand or collapse all reporting lines"
              type="button"
            >
              <UnfoldVertical aria-hidden="true" size={15} />
            </button>
            <button
              aria-label="Reset chart view"
              onClick={resetView}
              title="Reset chart view"
              type="button"
            >
              <Focus aria-hidden="true" size={15} />
            </button>
            <button
              aria-label={fullscreen ? "Exit full screen" : "Open full screen"}
              aria-pressed={fullscreen}
              onClick={toggleFullscreen}
              title={fullscreen ? "Exit full screen" : "Open full screen"}
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
            data-panning={panning}
            onKeyDown={handleViewportKeyDown}
            onPointerCancel={stopPan}
            onPointerDown={startPan}
            onPointerMove={movePan}
            onPointerUp={stopPan}
            onWheel={() => setViewMode("manual")}
            ref={viewportRef}
            tabIndex={0}
          >

          <div className={styles.desktopChart} style={frameStyle}>
            <div className={styles.chartWorld} style={worldStyle}>
              <svg
                aria-hidden="true"
                className={styles.connectors}
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
                  return (
                    <path
                      className={styles.connector}
                      d={getConnectorPath(
                        connector,
                        layoutNodesById,
                        manualOffsets,
                      )}
                      data-active={active}
                      data-arranging={arranging}
                      data-company={connector.sourceCompany}
                      key={connector.id}
                      markerEnd={`url(#${markerPrefix}-${connector.sourceCompany})`}
                    />
                  );
                })}
              </svg>

              {layout.nodes.map((item) => {
                const collapsed = effectiveCollapsedIds.has(item.node.id);
                const related = relatedIds.has(item.node.id);
                const offset = manualOffsets[item.node.id] ?? { x: 0, y: 0 };
                const muted = Boolean(selectedId) && !related;
                return (
                  <div
                    className={styles.nodeWrap}
                    data-arrange={arrangeMode}
                    data-company={item.node.company}
                    data-dragging={draggingNodeId === item.node.id}
                    data-drop-target={dropTargetId === item.node.id}
                    data-manual={Boolean(manualOffsets[item.node.id])}
                    data-muted={muted}
                    data-node-id={item.node.id}
                    data-selected={selectedId === item.node.id}
                    key={item.node.id}
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
                      title={
                        arrangeMode
                          ? "Drop on another person to change their reporting line, or on empty space to arrange locally."
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

                    {item.hasChildren ? (
                      <button
                        aria-expanded={!collapsed}
                        aria-label={`${collapsed ? "Show" : "Hide"} ${item.descendantCount} people under ${item.node.name}`}
                        className={styles.branchToggle}
                        data-company={item.node.company}
                        onClick={() => toggleBranch(item.node.id)}
                        title={`${collapsed ? "Show" : "Hide"} ${item.descendantCount} people`}
                        type="button"
                      >
                        {collapsed ? (
                          <ChevronRight aria-hidden="true" size={13} />
                        ) : (
                          <ChevronDown aria-hidden="true" size={13} />
                        )}
                        <span>{item.descendantCount}</span>
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <ul aria-label="Organisation reporting tree" className={styles.mobileTree}>
            {presentationForest.map((root) => (
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
          <aside aria-label={`${selectedProfile.name} details`} className={styles.inspector}>
            <header className={styles.inspectorHeader} data-company={selectedProfile.company}>
              <div>
                <span>{selectedProfile.position || companyLabels[selectedProfile.company]}</span>
                <strong>{selectedProfile.name}</strong>
              </div>
              <button
                aria-label="Close person details"
                onClick={() => {
                  dismissInspector();
                }}
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
                          <p>Work contact could not be loaded. Try again.</p>
                        ) : onRequestWorkEmail ? (
                          <p>Work email not listed.</p>
                        ) : (
                          <p>Work contact is unavailable.</p>
                        )}
                </section>
              ) : null}

              <section className={styles.relationships}>
                <div className={styles.relationshipHeader}>
                  <span>Reports to</span>
                  {onOpenEmployeeRecord && isPerson(selectedProfile) ? (
                    <button
                      aria-label={`Edit ${selectedProfile.name}'s reporting line`}
                      className={styles.relationshipEdit}
                      onClick={() => openEmployeeRecord(selectedProfile.id)}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={13} /> Change
                    </button>
                  ) : null}
                </div>
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
                  onClick={() => openEmployeeRecord(selectedProfile.id)}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={15} />
                  Edit HR profile
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
            aria-describedby={descriptionId}
            aria-labelledby={`${titleId}-editor`}
            aria-modal="true"
            className={styles.drawer}
            role="dialog"
          >
            <header className={styles.drawerHeader}>
              <div>
                <span className={styles.eyebrow}>Organisation</span>
                <h3 id={`${titleId}-editor`}>
                  {activeEditor.mode === "create" ? "Add person" : "Edit person"}
                </h3>
                <p id={descriptionId}>Name, position and reporting line.</p>
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
              <label>
                <span>Name</span>
                <input
                  autoComplete="off"
                  autoFocus
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  required
                  value={draft.name}
                />
              </label>

              <label>
                <span>Position</span>
                <input
                  autoComplete="off"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      position: event.target.value,
                    }))
                  }
                  required
                  value={draft.position}
                />
              </label>

              <label>
                <span>Company</span>
                <select
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      company: event.target.value as OrganisationCompany,
                    }))
                  }
                  value={draft.company}
                >
                  <option value="mam">MAM</option>
                  <option value="equipsy">Equipsy</option>
                </select>
              </label>

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
                    const identifier = duplicate ? ` · ${profile.id}` : "";
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
