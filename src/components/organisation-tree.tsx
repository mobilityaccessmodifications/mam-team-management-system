"use client";

import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  Minus,
  Network,
  Pencil,
  Plus,
  Search,
  UnfoldVertical,
  X,
} from "lucide-react";
import {
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
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
  canEdit?: boolean;
  onCreate?: (person: OrganisationPersonDraft) => Promise<void>;
  onUpdate?: (
    id: string,
    person: OrganisationPersonDraft,
  ) => Promise<void>;
  className?: string;
};

type CompanyFilter = "all" | OrganisationCompany;
type TreeNode = OrganisationPerson & { children: TreeNode[] };
type EditorState =
  | { mode: "create" }
  | { mode: "update"; id: string }
  | null;

const companyLabels: Record<OrganisationCompany, string> = {
  mam: "MAM",
  equipsy: "Equipsy",
};

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
    const children = (childrenByParent.get(profile.id) ?? [])
      .map((child) => visit(child, nextAncestors))
      .filter((child): child is TreeNode => child !== null);

    return { ...profile, children };
  };

  const roots = visible.filter(
    (profile) =>
      !profile.reportsTo ||
      profile.reportsTo === profile.id ||
      !visibleById.has(profile.reportsTo),
  );
  const forest = roots
    .map((root) => visit(root, new Set()))
    .filter((root): root is TreeNode => root !== null);

  // Corrupt or circular reporting data should remain visible, not break the tree.
  for (const profile of visible) {
    if (!visited.has(profile.id)) {
      const root = visit(profile, new Set());
      if (root) forest.push(root);
    }
  }

  return forest;
}

function TreeBranch({
  node,
  depth,
  parentCompany,
  collapsedIds,
  matchingIds,
  editMode,
  canUpdate,
  onEdit,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  parentCompany?: OrganisationCompany;
  collapsedIds: Set<string>;
  matchingIds: Set<string>;
  editMode: boolean;
  canUpdate: boolean;
  onEdit: (profile: OrganisationPerson) => void;
  onToggle: (id: string) => void;
}) {
  const unit = node.kind === "org_unit";
  const collapsed = collapsedIds.has(node.id);
  const hasChildren = node.children.length > 0;
  const compact = node.children.length >= 5 || (depth >= 2 && node.children.length >= 3);
  const showCompany = depth === 0 || parentCompany !== node.company || unit;

  return (
    <li className={styles.branch}>
      <article
        className={`${styles.card} ${unit ? styles.unitCard : ""} ${
          matchingIds.has(node.id) ? styles.matchingCard : ""
        }`}
        data-company={node.company}
        data-node-id={node.id}
      >
        <div className={styles.cardCopy}>
          <div className={styles.nameRow}>
            <strong>{node.name}</strong>
            {showCompany ? (
              <span className={styles.companyBadge} data-company={node.company}>
                {companyLabels[node.company]}
              </span>
            ) : null}
            {unit ? <span className={styles.unitBadge}>Group</span> : null}
          </div>
          {node.position ? <p>{node.position}</p> : null}
        </div>

        {editMode && !unit ? (
          <button
            aria-label={`Edit ${node.name}`}
            className={styles.nodeEdit}
            disabled={!canUpdate}
            onClick={() => onEdit(node)}
            type="button"
          >
            <Pencil aria-hidden="true" size={14} />
            <span>Edit</span>
          </button>
        ) : null}

        {hasChildren ? (
          <button
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Show" : "Hide"} ${node.children.length} direct ${
              node.children.length === 1 ? "report" : "reports"
            } under ${node.name}`}
            className={styles.branchToggle}
            onClick={() => onToggle(node.id)}
            type="button"
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" size={13} />
            ) : (
              <ChevronDown aria-hidden="true" size={13} />
            )}
            <span>{node.children.length}</span>
          </button>
        ) : null}
      </article>

      {hasChildren && !collapsed ? (
        <ul className={styles.branches} data-compact={compact}>
          {node.children.map((child) => (
            <TreeBranch
              canUpdate={canUpdate}
              collapsedIds={collapsedIds}
              depth={depth + 1}
              editMode={editMode}
              key={child.id}
              matchingIds={matchingIds}
              node={child}
              onEdit={onEdit}
              onToggle={onToggle}
              parentCompany={node.company}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function OrganisationTree({
  profiles,
  canEdit = false,
  onCreate,
  onUpdate,
  className,
}: OrganisationTreeProps) {
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState<CompanyFilter>("all");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [searchCollapsedIds, setSearchCollapsedIds] = useState<Set<string>>(
    new Set(),
  );
  const [zoom, setZoom] = useState(0.85);
  const [panning, setPanning] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [draft, setDraft] = useState<OrganisationPersonDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    if (!editor) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setEditor(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editor, saving]);

  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const activeEditor =
    canEdit &&
    (editor?.mode === "create" ||
      (editor?.mode === "update" &&
        profiles.some(
          (profile) => profile.id === editor.id && isPerson(profile),
        )))
      ? editor
      : null;

  const companyProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          companyFilter === "all" || profile.company === companyFilter,
      ),
    [companyFilter, profiles],
  );
  const matchingIds = useMemo(() => {
    const cleanedQuery = normalise(query);
    if (!cleanedQuery) return new Set<string>();
    return new Set(
      companyProfiles
        .filter((profile) =>
          normalise(
            `${profile.name} ${profile.position} ${companyLabels[profile.company]}`,
          ).includes(cleanedQuery),
        )
        .map((profile) => profile.id),
    );
  }, [companyProfiles, query]);
  const companyPersonCount = useMemo(
    () => companyProfiles.filter(isPerson).length,
    [companyProfiles],
  );
  const visibleIds = useMemo(() => {
    const cleanedQuery = normalise(query);
    if (!cleanedQuery) {
      return new Set(companyProfiles.map((profile) => profile.id));
    }

    const ids = new Set(matchingIds);

    // A search keeps matching reporting lines visible for context. Company
    // filters remain strict, so they never leak people from the other company.
    for (const matchId of matchingIds) {
      const match = profileById.get(matchId);
      if (!match) continue;
      const seen = new Set<string>();
      let managerId = match.reportsTo;
      while (managerId && !seen.has(managerId)) {
        seen.add(managerId);
        const manager = profileById.get(managerId);
        if (!manager) break;
        if (companyFilter === "all" || manager.company === companyFilter) {
          ids.add(manager.id);
        }
        managerId = manager.reportsTo;
      }
    }

    return ids;
  }, [companyFilter, companyProfiles, matchingIds, profileById, query]);
  const visiblePersonCount = useMemo(
    () =>
      companyProfiles.filter(
        (profile) => isPerson(profile) && visibleIds.has(profile.id),
      ).length,
    [companyProfiles, visibleIds],
  );

  const forest = useMemo(
    () => buildForest(profiles, visibleIds),
    [profiles, visibleIds],
  );

  const editorProfile =
    activeEditor?.mode === "update"
      ? profileById.get(activeEditor.id)
      : undefined;
  const excludedManagerIds = useMemo(() => {
    if (!editorProfile) return new Set<string>();
    return getDescendantIds(editorProfile.id, profiles).add(editorProfile.id);
  }, [editorProfile, profiles]);
  const managerOptions = profiles.filter(
    (profile) => !excludedManagerIds.has(profile.id),
  );

  const branchIds = useMemo(
    () =>
      new Set(
        companyProfiles
          .filter((profile) =>
            companyProfiles.some((candidate) => candidate.reportsTo === profile.id),
          )
          .map((profile) => profile.id),
      ),
    [companyProfiles],
  );

  const duplicateManagerLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of managerOptions) {
      const key = `${profile.name}\u0000${profile.position}\u0000${profile.company}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [managerOptions]);

  const searchAncestorIds = useMemo(() => {
    const ancestors = new Set<string>();
    if (!normalise(query)) return ancestors;

    for (const matchId of matchingIds) {
      let managerId = profileById.get(matchId)?.reportsTo;
      const seen = new Set<string>();
      while (managerId && !seen.has(managerId)) {
        seen.add(managerId);
        ancestors.add(managerId);
        managerId = profileById.get(managerId)?.reportsTo;
      }
    }
    return ancestors;
  }, [matchingIds, profileById, query]);
  const visibleCollapsedIds = useMemo(() => {
    if (!searchAncestorIds.size) return collapsedIds;
    return new Set([
      ...[...collapsedIds].filter((id) => !searchAncestorIds.has(id)),
      ...searchCollapsedIds,
    ]);
  }, [collapsedIds, searchAncestorIds, searchCollapsedIds]);

  useEffect(() => {
    const cleanedQuery = normalise(query);
    if (!cleanedQuery || !matchingIds.size) return;

    const timer = window.setTimeout(() => {
      const viewport = viewportRef.current;
      const node = viewport?.querySelector<HTMLElement>(`.${styles.matchingCard}`);
      if (!viewport || !node) return;
      const viewportRect = viewport.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      viewport.scrollTo({
        behavior: "smooth",
        left:
          viewport.scrollLeft +
          nodeRect.left -
          viewportRect.left -
          (viewport.clientWidth - nodeRect.width) / 2,
        top:
          viewport.scrollTop +
          nodeRect.top -
          viewportRect.top -
          Math.min(120, (viewport.clientHeight - nodeRect.height) / 2),
      });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [matchingIds, query]);

  const toggleBranch = (id: string) => {
    if (normalise(query) && searchAncestorIds.has(id)) {
      setSearchCollapsedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }

    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllBranches = () => {
    const allCollapsed =
      branchIds.size > 0 &&
      [...branchIds].every((id) => visibleCollapsedIds.has(id));
    const next = allCollapsed ? new Set<string>() : new Set(branchIds);
    setCollapsedIds(next);
    setSearchCollapsedIds(
      normalise(query)
        ? new Set([...next].filter((id) => searchAncestorIds.has(id)))
        : new Set(),
    );
  };

  const resetView = () => {
    setZoom(0.85);
    setCollapsedIds(new Set());
    setSearchCollapsedIds(new Set());
    const viewport = viewportRef.current;
    if (!viewport) return;
    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        behavior: "smooth",
        left: Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2),
        top: 0,
      });
    });
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, label")) return;
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

  const openCreate = () => {
    const company = companyFilter === "all" ? "mam" : companyFilter;
    setDraft({ ...emptyDraft, company });
    setError("");
    setEditor({ mode: "create" });
  };

  const openUpdate = (profile: OrganisationPerson) => {
    if (!isPerson(profile)) return;
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

  return (
    <section aria-labelledby={titleId} className={rootClassName}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>People</span>
          <h2 id={titleId}>Organisation</h2>
          <p>Reporting lines across MAM and Equipsy.</p>
        </div>

        {canEdit ? (
          <div className={styles.actions}>
            <button
              aria-pressed={editMode}
              className={styles.secondaryAction}
              onClick={() => setEditMode((current) => !current)}
              type="button"
            >
              <Pencil aria-hidden="true" size={15} />
              {editMode ? "Done editing" : "Edit tree"}
            </button>
            <button
              className={styles.primaryAction}
              disabled={!onCreate}
              onClick={openCreate}
              type="button"
            >
              <Plus aria-hidden="true" size={16} />
              Add person
            </button>
          </div>
        ) : null}
      </header>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search aria-hidden="true" size={16} />
          <span className={styles.srOnly}>Search the organisation</span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchCollapsedIds(new Set());
            }}
            placeholder="Search people or positions"
            type="search"
            value={query}
          />
        </label>

        <div aria-label="Filter by company" className={styles.filters}>
          {(["all", "mam", "equipsy"] as const).map((filter) => (
            <button
              aria-pressed={companyFilter === filter}
              data-active={companyFilter === filter}
              data-company={filter}
              key={filter}
              onClick={() => {
                setCompanyFilter(filter);
                setSearchCollapsedIds(new Set());
              }}
              type="button"
            >
              {filter === "all" ? "All" : companyLabels[filter]}
            </button>
          ))}
        </div>
      </div>

      <span aria-live="polite" className={styles.srOnly}>
        {normalise(query)
          ? `${matchingIds.size} ${matchingIds.size === 1 ? "match" : "matches"}`
          : `${visiblePersonCount} ${visiblePersonCount === 1 ? "person" : "people"}`}
      </span>

      {forest.length ? (
        <div
          className={styles.treeViewport}
          data-panning={panning}
          onPointerCancel={stopPan}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={stopPan}
          ref={viewportRef}
        >
          <div className={styles.chartMeta}>
            <span>{companyPersonCount} people</span>
            <span>Drag to move</span>
          </div>

          <div aria-label="Chart view controls" className={styles.chartControls}>
            <button
              aria-label="Zoom out"
              disabled={zoom <= 0.6}
              onClick={() => setZoom((current) => Math.max(0.6, current - 0.1))}
              type="button"
            >
              <Minus aria-hidden="true" size={15} />
            </button>
            <span aria-label={`${Math.round(zoom * 100)} percent zoom`}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              aria-label="Zoom in"
              disabled={zoom >= 1.2}
              onClick={() => setZoom((current) => Math.min(1.2, current + 0.1))}
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
            </button>
            <button
              aria-label="Expand or collapse all reporting lines"
              onClick={toggleAllBranches}
              type="button"
            >
              <UnfoldVertical aria-hidden="true" size={15} />
            </button>
            <button aria-label="Reset chart view" onClick={resetView} type="button">
              <LocateFixed aria-hidden="true" size={15} />
            </button>
          </div>

          <div
            className={styles.chartCanvas}
            style={{ "--chart-zoom": zoom } as CSSProperties}
          >
            <ul aria-label="Organisation reporting tree" className={styles.tree}>
              {forest.map((root) => (
                <TreeBranch
                  canUpdate={Boolean(onUpdate)}
                  collapsedIds={visibleCollapsedIds}
                  depth={0}
                  editMode={canEdit && editMode}
                  key={root.id}
                  matchingIds={matchingIds}
                  node={root}
                  onEdit={openUpdate}
                  onToggle={toggleBranch}
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
                <p id={descriptionId}>Keep the reporting line current.</p>
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
