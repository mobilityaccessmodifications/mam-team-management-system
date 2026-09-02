"use client";

import {
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ContactRound,
  CreditCard,
  FileCheck2,
  KeyRound,
  Laptop,
  ListChecks,
  Network,
  Paperclip,
  Plus,
  RotateCcw,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { ChangeEvent, FormEvent, type ReactNode, useMemo, useRef, useState } from "react";

import { AboutMeDemo } from "@/components/about-me-demo";
import { getOrganisationPersonWorkEmail } from "@/app/people/actions";
import {
  MotionTabs,
  type MotionTabOption,
} from "@/components/ui/motion-tabs";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  OrganisationTree,
  type OrganisationPerson,
  type OrganisationPersonDraft,
} from "@/components/organisation-tree";
import styles from "@/components/people-operations-demo.module.css";

type AccessRole = "hr" | "manager" | "employee";
type PeopleSection = "profile" | "directory" | "organisation" | "tasks" | "checkins" | "accounts" | "assets" | "subscriptions";
type PeopleTaskSection = "onboarding" | "offboarding" | "checkins";
type WorkflowKind = "onboarding" | "offboarding";
type TaskOwner = "HR" | "Team Leader" | "IT" | "Accounts" | "Analyst" | "Warehouse" | "Employee";
type TaskStatus = "Not Started" | "In Progress" | "Complete" | "Overdue";
type AssetStatus = "Required" | "Issued" | "Returned" | "Pending return";
type AccessStatus = "Requested" | "Approved" | "Provisioning" | "Active" | "Revocation due" | "Revoked";
type ReminderStatus = "Scheduled" | "Completed";

export type PeopleOperationsProfile = {
  name: string;
  initials: string;
  accessRole: AccessRole;
  roleLabel: string;
  team: string;
  manager: string;
  startedDate?: string;
  company: "mam" | "equipsy";
};

/** @deprecated Kept temporarily for the parent component's compatibility. */
export type PeopleOperationsEmailPreview = {
  notificationKey: string;
  recipient: string;
  recipientName: string;
  subject: string;
  details: string[];
};

/** @deprecated Check-in email delivery is no longer part of this workspace. */
export type PeopleOperationsEmailResult = {
  deliveredKeys: string[];
  failedKeys: string[];
};

type WorkflowTask = {
  id: string;
  group: string;
  title: string;
  owner: TaskOwner;
  due: string;
  status: TaskStatus;
  evidence?: string;
};

type WorkflowAsset = {
  id: string;
  item: string;
  owner: TaskOwner;
  status: AssetStatus;
};

type AccessRequest = {
  id: string;
  service: string;
  owner: string;
  businessNeed: string;
  renewal: string;
  status: AccessStatus;
};

type AuditEntry = { id: string; actor: string; action: string; time: string };

type PeopleWorkflow = {
  id: string;
  personId: string;
  kind: WorkflowKind;
  employee: string;
  initials: string;
  role: string;
  department: string;
  manager: string;
  date: string;
  tasks: WorkflowTask[];
  assets: WorkflowAsset[];
  access: AccessRequest[];
  audit: AuditEntry[];
};

type CheckInPerson = {
  id: string;
  name: string;
  role: string;
  department: string;
  manager: string;
  startDate: string;
};

type CheckInReminder = {
  id: string;
  personId: string;
  milestone: "2-week" | "1-month" | "3-month" | "5-month probation";
  sequence: "Initial" | "Final";
  checkInDate: string;
  notifyDate: string;
  status: ReminderStatus;
  snoozedUntil?: string;
};

const initialWorkflows: PeopleWorkflow[] = [];
const initialPeople: CheckInPerson[] = [];
const initialReminders: CheckInReminder[] = [];
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return `${day} ${shortMonths[month - 1]} ${year}`;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonths(value: string, months: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

function subtractBusinessDays(value: string, days: number) {
  let remaining = days;
  let cursor = value;
  while (remaining > 0) {
    cursor = addDays(cursor, -1);
    const weekday = new Date(`${cursor}T12:00:00`).getDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return cursor;
}

function workflowProgress(workflow: PeopleWorkflow) {
  if (!workflow.tasks.length) return 0;
  return Math.round((workflow.tasks.filter((task) => task.status === "Complete").length / workflow.tasks.length) * 100);
}

function workflowOverdueCount(workflow: PeopleWorkflow) {
  return workflow.tasks.filter((task) => task.status === "Overdue").length;
}

function workflowStatus(workflow: PeopleWorkflow) {
  const progress = workflowProgress(workflow);
  if (workflow.kind === "onboarding" && progress === 100) return "Ready for Day 1";
  if (workflow.kind === "offboarding" && progress === 100) return "Offboarding complete";
  if (workflowOverdueCount(workflow)) return "Needs attention";
  return "In progress";
}

function createAudit(actor: string, action: string): AuditEntry {
  return { id: crypto.randomUUID(), actor, action, time: "Just now" };
}

function createOnboardingTasks(startDate: string): WorkflowTask[] {
  return [
    { id: crypto.randomUUID(), group: "HR documents", title: "Employee file, starter forms and right-to-work checks", owner: "HR", due: addDays(startDate, -7), status: "Not Started" },
    { id: crypto.randomUUID(), group: "HR documents", title: "Assign induction lead, buddy and check-in schedule", owner: "HR", due: addDays(startDate, -5), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Equipment", title: "Laptop, equipment and mobile ready", owner: "Warehouse", due: addDays(startDate, -3), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Systems & access", title: "Payroll and Deputy request confirmed", owner: "Accounts", due: addDays(startDate, -3), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Systems & access", title: "Microsoft, AroFlo, Hubstaff and 3CX access request", owner: "IT", due: addDays(startDate, -2), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Systems & access", title: "LMS, reporting and role-based access provisioned", owner: "Analyst", due: addDays(startDate, -2), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Pre-start & first day", title: "Policies, first-week plan and key contacts shared", owner: "Team Leader", due: addDays(startDate, -1), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Pre-start & first day", title: "Tour, safety, role expectations and leave process completed", owner: "Employee", due: startDate, status: "Not Started" },
  ];
}

function createOffboardingTasks(endDate: string): WorkflowTask[] {
  return [
    { id: crypto.randomUUID(), group: "Exit confirmation", title: "Confirm final working day and equipment return expectations", owner: "HR", due: addDays(endDate, -7), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Exit confirmation", title: "Issue offboarding brief to owners and confirm handover", owner: "Team Leader", due: addDays(endDate, -5), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Systems & licences", title: "Microsoft mailbox, shared inbox and data retention decision", owner: "IT", due: addDays(endDate, -2), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Systems & licences", title: "AroFlo, Hubstaff, Deputy, 3CX, LMS and reporting cleanup", owner: "Analyst", due: addDays(endDate, -1), status: "Not Started" },
    { id: crypto.randomUUID(), group: "Assets & physical access", title: "Recover equipment, tools, PPE, SIM and site access", owner: "Warehouse", due: endDate, status: "Not Started" },
    { id: crypto.randomUUID(), group: "Handover & close-out", title: "Reassign files, inboxes and active jobs", owner: "Team Leader", due: endDate, status: "Not Started" },
    { id: crypto.randomUUID(), group: "Handover & close-out", title: "Confirm equipment return and handover arrangements", owner: "Employee", due: endDate, status: "Not Started" },
    { id: crypto.randomUUID(), group: "Handover & close-out", title: "Final timesheet, exit interview and signed close-out", owner: "Accounts", due: addDays(endDate, 2), status: "Not Started" },
  ];
}

function createAssets(kind: WorkflowKind): WorkflowAsset[] {
  return [
    { id: crypto.randomUUID(), item: "Laptop and peripherals", owner: "IT", status: kind === "onboarding" ? "Issued" : "Pending return" },
    { id: crypto.randomUUID(), item: "Mobile and SIM", owner: "Team Leader", status: kind === "onboarding" ? "Required" : "Pending return" },
    { id: crypto.randomUUID(), item: "Tools, PPE and uniform", owner: "Warehouse", status: kind === "onboarding" ? "Required" : "Pending return" },
    { id: crypto.randomUUID(), item: "Vehicle or site access", owner: "Team Leader", status: kind === "onboarding" ? "Required" : "Pending return" },
  ];
}

function createAccessRequests(kind: WorkflowKind): AccessRequest[] {
  const offboarding = kind === "offboarding";
  return [
    { id: crypto.randomUUID(), service: "Microsoft 365 & SharePoint", owner: "IT", businessNeed: offboarding ? "Remove access and choose data retention" : "Email, files and role access", renewal: "Annual review", status: offboarding ? "Revocation due" : "Provisioning" },
    { id: crypto.randomUUID(), service: "AroFlo, Deputy & Hubstaff", owner: "Analyst", businessNeed: offboarding ? "Disable and reclaim licences" : "Roster, job and time access", renewal: "Role review", status: offboarding ? "Revocation due" : "Requested" },
    { id: crypto.randomUUID(), service: "Role subscription", owner: "HR", businessNeed: offboarding ? "Revoke role-based access" : "Role-based business need", renewal: "Review when role changes", status: offboarding ? "Revocation due" : "Requested" },
  ];
}

function createCheckInReminders(personId: string, startDate: string): CheckInReminder[] {
  const twoWeek = addDays(startDate, 14);
  const oneMonth = addMonths(startDate, 1);
  const threeMonth = addMonths(startDate, 3);
  const fiveMonth = addMonths(startDate, 5);
  return [
    { id: crypto.randomUUID(), personId, milestone: "2-week", sequence: "Initial", checkInDate: twoWeek, notifyDate: addDays(twoWeek, -3), status: "Scheduled" },
    { id: crypto.randomUUID(), personId, milestone: "1-month", sequence: "Initial", checkInDate: oneMonth, notifyDate: subtractBusinessDays(oneMonth, 4), status: "Scheduled" },
    { id: crypto.randomUUID(), personId, milestone: "3-month", sequence: "Initial", checkInDate: threeMonth, notifyDate: addDays(threeMonth, -14), status: "Scheduled" },
    { id: crypto.randomUUID(), personId, milestone: "5-month probation", sequence: "Initial", checkInDate: fiveMonth, notifyDate: addDays(fiveMonth, -14), status: "Scheduled" },
    { id: crypto.randomUUID(), personId, milestone: "5-month probation", sequence: "Final", checkInDate: fiveMonth, notifyDate: addDays(fiveMonth, -7), status: "Scheduled" },
  ];
}

function statusClass(status: string) {
  if (["Complete", "Ready for Day 1", "Offboarding complete", "Active", "Revoked", "Completed"].includes(status)) return styles.success;
  if (["Overdue", "Needs attention", "Revocation due"].includes(status)) return styles.danger;
  if (["In Progress", "Provisioning"].includes(status)) return styles.progress;
  return styles.neutral;
}

function initialsFor(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function detailsForPerson(person: OrganisationPerson, profiles: OrganisationPerson[]) {
  const parent = profiles.find((candidate) => candidate.id === person.reportsTo);
  const manager = parent?.kind === "person" ? parent.name : "";
  const department = parent?.kind === "org_unit" ? parent.name : person.company === "equipsy" ? "Equipsy" : "MAM";
  return { manager, department };
}

export function PeopleOperationsDemo({
  activeProfile,
  organisationProfiles,
  canEditOrganisation,
  canArrangeOrganisation = false,
  onCreateOrganisationPerson,
  onUpdateOrganisationPerson,
  onOpenEmployeeDirectoryRecord,
  renderEmployeeDirectory,
  renderCheckInRegister,
  renderCheckInTasks,
  renderAccounts,
  renderAssetRegister,
  renderSubscriptionRegister,
  legacyCheckInFormsUrl,
  showProfile = true,
  showTasks,
  isAccessPreview = false,
}: {
  activeProfile: PeopleOperationsProfile;
  organisationProfiles: OrganisationPerson[];
  canEditOrganisation: boolean;
  /** Allows the safe visual arrangement controls for a normal HR workspace only. */
  canArrangeOrganisation?: boolean;
  onCreateOrganisationPerson: (person: OrganisationPersonDraft) => Promise<void>;
  onUpdateOrganisationPerson: (id: string, person: OrganisationPersonDraft) => Promise<void>;
  /** @deprecated Ignored; retained until the parent removes the old email log adapter. */
  onEmailPreview?: (previews: PeopleOperationsEmailPreview[]) => Promise<PeopleOperationsEmailResult>;
  /** Rendered only after the real signed-in session has passed the HR directory check. */
  renderEmployeeDirectory?: ReactNode;
  /** Durable session-authorised Check-in workspace; its DTO is chosen by the parent. */
  renderCheckInRegister?: ReactNode;
  /** Scoped, server-authorised manager task list. */
  renderCheckInTasks?: (toolbarAction?: ReactNode) => ReactNode;
  /** Opens the selected safe tree node in the HR-only directory detail drawer. */
  onOpenEmployeeDirectoryRecord?: (personId: string) => void;
  renderAccounts?: ReactNode;
  /** System-admin asset register. The component rechecks its own server capability. */
  renderAssetRegister?: ReactNode;
  /** System Admin-managed subscription register; managers receive its read-only projection. */
  renderSubscriptionRegister?: ReactNode;
  /** Optional deployment-configured link used only by the legacy demo view. */
  legacyCheckInFormsUrl?: string | null;
  /** Lets a constrained employee workspace omit the legacy Profile tab. */
  showProfile?: boolean;
  /** Exposes the self-only task surface when a scoped manager task list is unavailable. */
  showTasks?: boolean;
  /** Read-only UI preview for an administrator; it never changes the session. */
  isAccessPreview?: boolean;
}) {
  const hasRealCheckInTasks = renderCheckInTasks !== undefined;
  const hasTasks = showTasks ?? hasRealCheckInTasks;
  const availableSections = useMemo<PeopleSection[]>(() => [
    ...(renderEmployeeDirectory ? ["directory" as const] : []),
    ...(showProfile ? ["profile" as const] : []),
    "organisation",
    ...(renderCheckInRegister ? ["checkins" as const] : []),
    ...(hasTasks ? ["tasks" as const] : []),
    ...(renderAccounts ? ["accounts" as const] : []),
    ...(renderAssetRegister ? ["assets" as const] : []),
    ...(renderSubscriptionRegister ? ["subscriptions" as const] : []),
  ], [hasTasks, renderAccounts, renderAssetRegister, renderCheckInRegister, renderEmployeeDirectory, renderSubscriptionRegister, showProfile]);
  const [section, setSection] = useState<PeopleSection>(() => availableSections[0] ?? "organisation");
  const [taskSection, setTaskSection] = useState<PeopleTaskSection>(
    renderCheckInRegister ? "onboarding" : "checkins",
  );
  const [workflows, setWorkflows] = useState<PeopleWorkflow[]>(initialWorkflows);
  const [people, setPeople] = useState<CheckInPerson[]>(initialPeople);
  const [reminders, setReminders] = useState<CheckInReminder[]>(initialReminders);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<WorkflowKind | "checkin">("onboarding");
  const [toast, setToast] = useState("");

  // Capability changes can remove a section (for example when Super Admin
  // exits Change profile). Render the first permitted tab immediately rather
  // than keeping a stale selection or synchronously setting state in an
  // effect.
  const visibleSection = availableSections.includes(section)
    ? section
    : availableSections[0] ?? "organisation";

  const canManage = !isAccessPreview && (activeProfile.accessRole === "hr" || activeProfile.accessRole === "manager");
  const isEmployee = activeProfile.accessRole === "employee";
  const accessibleWorkflows = useMemo(() => workflows.filter((workflow) => {
    if (activeProfile.accessRole === "hr" && !isAccessPreview) return true;
    if (activeProfile.accessRole === "manager") return workflow.manager === activeProfile.name;
    return workflow.employee === activeProfile.name;
  }), [activeProfile, isAccessPreview, workflows]);
  const visiblePeople = useMemo(() => people.filter((person) => {
    if (activeProfile.accessRole === "hr" && !isAccessPreview) return true;
    if (activeProfile.accessRole === "manager") return person.manager === activeProfile.name;
    return person.name === activeProfile.name;
  }), [activeProfile, isAccessPreview, people]);
  const visibleReminders = useMemo(() => reminders.filter((reminder) => visiblePeople.some((person) => person.id === reminder.personId)), [reminders, visiblePeople]);
  const employeeWorkflow = isEmployee
    ? accessibleWorkflows.find((workflow) => workflow.kind === "offboarding") ?? accessibleWorkflows.find((workflow) => workflow.kind === "onboarding")
    : undefined;
  const employeeLifecycleSection = employeeWorkflow?.kind;
  const visibleTaskSection: PeopleTaskSection = isEmployee && (taskSection === "onboarding" || taskSection === "offboarding")
    ? employeeLifecycleSection ?? "checkins"
    : taskSection;
  const workflowSection: WorkflowKind = visibleTaskSection === "offboarding" ? "offboarding" : "onboarding";
  const activeWorkflows = accessibleWorkflows.filter((workflow) => workflow.kind === workflowSection);
  const selectedWorkflow = activeWorkflows.find((workflow) => workflow.id === selectedWorkflowId) ?? activeWorkflows[0];
  const selectedPerson = visiblePeople.find((person) => person.id === selectedPersonId) ?? visiblePeople[0];

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function openCreate(mode: WorkflowKind | "checkin") {
    if (isAccessPreview) return;
    setCreateMode(mode);
    setShowCreate(true);
  }

  function updateTask(workflowId: string, taskId: string, nextStatus: TaskStatus, evidence?: string) {
    if (isAccessPreview) return;
    setWorkflows((current) => current.map((workflow) => {
      if (workflow.id !== workflowId) return workflow;
      const previousTask = workflow.tasks.find((task) => task.id === taskId);
      const tasks = workflow.tasks.map((task) => task.id === taskId ? { ...task, status: nextStatus, evidence: evidence ?? task.evidence } : task);
      const action = nextStatus === "Complete" ? `confirmed “${previousTask?.title ?? "task"}”` : `changed “${previousTask?.title ?? "task"}” to ${nextStatus}`;
      return { ...workflow, tasks, audit: [createAudit(activeProfile.name, action), ...workflow.audit] };
    }));
    announce(nextStatus === "Complete" ? "Task confirmed." : "Task status updated.");
  }

  function attachEvidence(event: ChangeEvent<HTMLInputElement>, workflowId: string, taskId: string) {
    if (isAccessPreview) return;
    const file = event.target.files?.[0];
    if (!file) return;
    updateTask(workflowId, taskId, "In Progress", file.name);
    announce(`${file.name} attached.`);
    event.target.value = "";
  }

  function updateAsset(workflowId: string, assetId: string) {
    if (isAccessPreview) return;
    setWorkflows((current) => current.map((workflow) => {
      if (workflow.id !== workflowId) return workflow;
      const asset = workflow.assets.find((item) => item.id === assetId);
      const status: AssetStatus = workflow.kind === "onboarding" ? "Issued" : "Returned";
      return { ...workflow, assets: workflow.assets.map((item) => item.id === assetId ? { ...item, status } : item), audit: [createAudit(activeProfile.name, `confirmed ${asset?.item ?? "asset"} as ${status.toLowerCase()}`), ...workflow.audit] };
    }));
    announce("Asset register updated.");
  }

  function updateAccess(workflowId: string, requestId: string) {
    if (isAccessPreview) return;
    setWorkflows((current) => current.map((workflow) => {
      if (workflow.id !== workflowId) return workflow;
      const request = workflow.access.find((item) => item.id === requestId);
      const status: AccessStatus = workflow.kind === "offboarding" ? "Revoked" : request?.status === "Requested" ? "Approved" : request?.status === "Approved" ? "Provisioning" : "Active";
      return { ...workflow, access: workflow.access.map((item) => item.id === requestId ? { ...item, status } : item), audit: [createAudit(activeProfile.name, `${request?.service ?? "Access request"} marked ${status.toLowerCase()}`), ...workflow.audit] };
    }));
    announce("Access register updated.");
  }

  function completeCheckIn(reminderId: string) {
    if (isAccessPreview) return;
    setReminders((current) => current.map((reminder) => reminder.id === reminderId ? { ...reminder, status: "Completed" } : reminder));
    announce("Check-in marked complete.");
  }

  function snoozeCheckIn(reminderId: string) {
    if (isAccessPreview) return;
    setReminders((current) => current.map((reminder) => reminder.id === reminderId ? { ...reminder, notifyDate: addDays(reminder.notifyDate, 7), snoozedUntil: addDays(reminder.notifyDate, 7) } : reminder));
    announce("Reminder moved one week later.");
  }

  function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isAccessPreview) return;
    const data = new FormData(event.currentTarget);
    const personId = String(data.get("personId") || "");
    const directoryPerson = organisationProfiles.find((person) => (
      person.id === personId
      && person.kind !== "org_unit"
      && person.isActive !== false
    ));
    if (!directoryPerson) {
      announce("Select a person from the organisation directory.");
      return;
    }
    const date = String(data.get("date") || "");
    if (!date) return;
    const { manager, department } = detailsForPerson(directoryPerson, organisationProfiles);
    const checkInPerson: CheckInPerson = { id: directoryPerson.id, name: directoryPerson.name, role: directoryPerson.position, department, manager, startDate: date };
    const existingPerson = people.find((person) => person.id === personId);

    if (createMode !== "offboarding" && !existingPerson) setPeople((current) => [...current, checkInPerson]);
    if (createMode !== "offboarding") setSelectedPersonId(personId);
    if (createMode === "checkin") {
      if (!existingPerson) setReminders((current) => [...createCheckInReminders(personId, date), ...current]);
      setSection("tasks");
      setTaskSection("checkins");
      setShowCreate(false);
      announce(existingPerson ? `${directoryPerson.name}'s check-ins are selected.` : `Check-in schedule created for ${directoryPerson.name}.`);
      return;
    }

    const kind = createMode;
    const id = `OPS-${kind === "onboarding" ? "ON" : "OFF"}-${String(workflows.length + 1).padStart(3, "0")}`;
    const workflow: PeopleWorkflow = {
      id,
      personId,
      kind,
      employee: directoryPerson.name,
      initials: initialsFor(directoryPerson.name),
      role: directoryPerson.position,
      department,
      manager,
      date,
      tasks: kind === "onboarding" ? createOnboardingTasks(date) : createOffboardingTasks(date),
      assets: createAssets(kind),
      access: createAccessRequests(kind),
      audit: [createAudit(activeProfile.name, `created the ${kind} checklist`)],
    };
    setWorkflows((current) => [workflow, ...current]);
    if (kind === "onboarding" && !existingPerson) {
      setReminders((current) => [...createCheckInReminders(personId, date), ...current]);
    }
    setSection("tasks");
    setTaskSection(kind);
    setSelectedWorkflowId(id);
    setShowCreate(false);
    announce(`${kind === "onboarding" ? "Onboarding" : "Offboarding"} checklist created for ${directoryPerson.name}.`);
  }

  const sectionTabs: MotionTabOption<PeopleSection>[] = availableSections.map((value) => {
    if (value === "directory") return { value, label: "Directory", icon: <ContactRound size={16} /> };
    if (value === "profile") return { value, label: "Profile", icon: <UserRound size={16} /> };
    if (value === "organisation") return { value, label: "Organisation", icon: <Network size={16} /> };
    if (value === "checkins") return { value, label: "Check-ins", icon: <CalendarClock size={16} /> };
    if (value === "tasks") return { value, label: "Tasks", icon: <ListChecks size={16} /> };
    if (value === "assets") return { value, label: "Assets", icon: <Laptop size={16} /> };
    if (value === "subscriptions") return { value, label: "Subscriptions", icon: <CreditCard size={16} /> };
    return { value, label: "Accounts", icon: <KeyRound size={16} /> };
  });

  const showTaskAction = canManage && visibleSection === "tasks";

  const taskAction = showTaskAction ? <button className={styles.primaryAction} type="button" onClick={() => openCreate(visibleTaskSection === "checkins" ? "checkin" : visibleTaskSection)}><Plus size={17} /> {visibleTaskSection === "checkins" ? "Schedule check-ins" : `Start ${visibleTaskSection}`}</button> : undefined;

  return <section className={styles.workspace} aria-label="People operations workspace">
    <MotionTabs
      value={visibleSection}
      onValueChange={setSection}
      options={sectionTabs}
      ariaLabel="People sections"
      className={styles.sectionSwitch}
    />

    {visibleSection === "profile" ? <AboutMeDemo roleLabel={activeProfile.roleLabel} manager={activeProfile.manager} company={activeProfile.company} /> : null}
    {visibleSection === "directory" ? renderEmployeeDirectory : null}
    {visibleSection === "checkins" ? renderCheckInRegister : null}
    {visibleSection === "organisation" ? <OrganisationTree profiles={organisationProfiles} canEdit={canEditOrganisation} canArrange={canArrangeOrganisation && !isAccessPreview} onCreate={onCreateOrganisationPerson} onUpdate={onUpdateOrganisationPerson} onRequestWorkEmail={getOrganisationPersonWorkEmail} onOpenEmployeeRecord={onOpenEmployeeDirectoryRecord ? (personId) => {
      onOpenEmployeeDirectoryRecord?.(personId);
      setSection("directory");
    } : undefined} /> : null}
    {visibleSection === "accounts" ? renderAccounts : null}
    {visibleSection === "assets" ? renderAssetRegister : null}
    {visibleSection === "subscriptions" ? renderSubscriptionRegister : null}
    {visibleSection === "tasks" && hasRealCheckInTasks ? renderCheckInTasks?.(taskAction) : null}
    {visibleSection === "tasks" && !hasRealCheckInTasks ? <nav className={styles.taskSwitch} aria-label="Task type">
      {!isEmployee || employeeLifecycleSection === "onboarding" ? <button type="button" aria-pressed={visibleTaskSection === "onboarding"} onClick={() => setTaskSection("onboarding")}>Onboarding</button> : null}
      {!renderCheckInRegister ? <button type="button" aria-pressed={visibleTaskSection === "checkins"} onClick={() => setTaskSection("checkins")}>Check-ins</button> : null}
      {!isEmployee || employeeLifecycleSection === "offboarding" ? <button type="button" aria-pressed={visibleTaskSection === "offboarding"} onClick={() => setTaskSection("offboarding")}>Offboarding</button> : null}
    </nav> : null}
    {visibleSection === "tasks" && !hasRealCheckInTasks && visibleTaskSection === "checkins" && !renderCheckInRegister ? <CheckInsView people={visiblePeople} reminders={visibleReminders} selectedPerson={selectedPerson} selectedPersonId={selectedPerson?.id} activeProfile={activeProfile} canManage={canManage} formsUrl={legacyCheckInFormsUrl} onSelectPerson={setSelectedPersonId} onComplete={completeCheckIn} onSnooze={snoozeCheckIn} /> : null}
    {visibleSection === "tasks" && !hasRealCheckInTasks && (visibleTaskSection === "onboarding" || visibleTaskSection === "offboarding") ? <WorkflowsView workflows={activeWorkflows} selected={selectedWorkflow} selectedId={selectedWorkflow?.id} activeProfile={activeProfile} onSelect={setSelectedWorkflowId} onTaskUpdate={updateTask} onAttach={attachEvidence} onAssetUpdate={updateAsset} onAccessUpdate={updateAccess} isAccessPreview={isAccessPreview} /> : null}

    {showCreate ? <CreateCaseModal mode={createMode} profiles={organisationProfiles} onClose={() => setShowCreate(false)} onSubmit={createCase} /> : null}
    <div className={`${styles.toast} ${toast ? styles.toastVisible : ""}`} role="status" aria-live="polite"><CheckCircle2 size={16} />{toast}</div>
  </section>;
}

function WorkflowsView({ workflows, selected, selectedId, activeProfile, onSelect, onTaskUpdate, onAttach, onAssetUpdate, onAccessUpdate, isAccessPreview = false }: {
  workflows: PeopleWorkflow[];
  selected?: PeopleWorkflow;
  selectedId?: string;
  activeProfile: PeopleOperationsProfile;
  onSelect: (id: string) => void;
  onTaskUpdate: (workflowId: string, taskId: string, status: TaskStatus) => void;
  onAttach: (event: ChangeEvent<HTMLInputElement>, workflowId: string, taskId: string) => void;
  onAssetUpdate: (workflowId: string, assetId: string) => void;
  onAccessUpdate: (workflowId: string, requestId: string) => void;
  isAccessPreview?: boolean;
}) {
  if (!workflows.length || !selected) return <div className={styles.emptyState}><UsersRound size={26} /><strong>{activeProfile.accessRole === "employee" ? "No people tasks are assigned to you" : "No workflows yet"}</strong><span>{activeProfile.accessRole === "employee" ? "Assigned tasks will appear here." : "Start a workflow for someone in the organisation directory."}</span></div>;
  const isEmployee = activeProfile.accessRole === "employee";
  const visibleTasks = isEmployee ? selected.tasks.filter((task) => task.owner === "Employee") : selected.tasks;
  const groups = Array.from(new Set(visibleTasks.map((task) => task.group)));
  const progress = isEmployee ? Math.round((visibleTasks.filter((task) => task.status === "Complete").length / Math.max(visibleTasks.length, 1)) * 100) : workflowProgress(selected);
  const visibleOverdue = isEmployee ? visibleTasks.filter((task) => task.status === "Overdue").length : workflowOverdueCount(selected);
  const status = isEmployee ? progress === 100 ? "Complete" : visibleOverdue ? "Needs attention" : "In progress" : workflowStatus(selected);
  const showWorkflowList = !isEmployee && workflows.length > 1;
  const canActionTask = (task: WorkflowTask) => !isAccessPreview && (activeProfile.accessRole === "hr" || (activeProfile.accessRole === "manager" && selected.manager === activeProfile.name && task.owner === "Team Leader") || (isEmployee && selected.employee === activeProfile.name && task.owner === "Employee"));
  const canActionRecord = (owner: string) => !isAccessPreview && (activeProfile.accessRole === "hr" || (activeProfile.accessRole === "manager" && selected.manager === activeProfile.name && owner === "Team Leader"));
  const visibleAssets = activeProfile.accessRole === "hr" ? selected.assets : selected.assets.filter((asset) => asset.owner === "Team Leader");
  const visibleAccess = activeProfile.accessRole === "hr" ? selected.access : selected.access.filter((request) => request.owner === "Team Leader");
  const showSupporting = !isEmployee && (activeProfile.accessRole === "hr" || visibleAssets.length > 0 || visibleAccess.length > 0);

  return <div className={`${styles.workflowDesk} ${!showWorkflowList ? styles.workflowDeskSingle : ""}`}>
    {showWorkflowList ? <aside className={styles.workflowList} aria-label="People workflow records"><header><span>{workflows.length} open</span><h2>{selected.kind === "onboarding" ? "New starters" : "Departures"}</h2></header>{workflows.map((workflow) => <button type="button" key={workflow.id} className={workflow.id === selectedId ? styles.workflowSelected : undefined} onClick={() => onSelect(workflow.id)}><span className={styles.caseAvatar}>{workflow.initials}</span><span><strong>{workflow.employee}</strong><em>{workflow.role} · {workflow.department}</em></span><span className={`${styles.statusPill} ${statusClass(workflowStatus(workflow))}`}>{workflowProgress(workflow)}%</span><ChevronRight size={15} /></button>)}</aside> : null}
    <article className={styles.workflowDetail}>
      <header className={styles.detailHeader}><div>{!isEmployee ? <span className={styles.caseAvatar}>{selected.initials}</span> : null}<span><small>{selected.kind === "onboarding" ? "Onboarding" : "Offboarding"}</small><h2>{isEmployee ? selected.kind === "onboarding" ? "My onboarding" : "My offboarding" : selected.employee}</h2><p>{selected.role}{selected.manager ? ` · Manager: ${selected.manager}` : ""}</p></span></div><span className={`${styles.statusPill} ${statusClass(status)}`}>{status}</span></header>
      <div className={styles.readiness}><div><span>{selected.kind === "onboarding" ? "Start date" : "Final working day"}</span><strong>{formatDate(selected.date)}</strong></div><div><span>Checklist progress</span><strong>{progress}%</strong><i><b style={{ width: `${progress}%` }} /></i></div><div><span>Overdue actions</span><strong>{visibleOverdue}</strong></div></div>
      <section className={styles.taskBoard} aria-label="Assigned checklist"><header><h3>{selected.kind === "onboarding" ? "Onboarding tasks" : "Offboarding tasks"}</h3></header>{groups.map((group) => <div className={styles.taskGroup} key={group}><h4>{group}</h4>{visibleTasks.filter((task) => task.group === group).map((task) => <div className={styles.taskRow} key={task.id}><span className={`${styles.taskMark} ${task.status === "Complete" ? styles.taskComplete : ""}`}>{task.status === "Complete" ? <Check size={14} /> : <CircleDot size={13} />}</span><span><strong>{task.title}</strong><small>{task.owner} · Due {formatDate(task.due)}{task.evidence ? " · Attachment added" : ""}</small></span><span className={`${styles.statusPill} ${statusClass(task.status)}`}>{task.status}</span>{canActionTask(task) ? <span className={styles.taskActions}><label title="Attach confirmation"><Paperclip size={14} /> Attach<input type="file" accept="application/pdf,image/*" onChange={(event) => onAttach(event, selected.id, task.id)} /></label><button type="button" onClick={() => onTaskUpdate(selected.id, task.id, task.status === "Complete" ? "In Progress" : "Complete")}>{task.status === "Complete" ? "Reopen" : "Confirm"}</button></span> : null}</div>)}</div>)}</section>
      {showSupporting ? <details className={styles.supportingDetails}><summary><span>{activeProfile.accessRole === "hr" ? "Assets, access and activity" : "Assets and access"}</span><small>Open when needed</small></summary><div className={styles.supportingContent}><div className={`${styles.detailGrid} ${visibleAssets.length && !visibleAccess.length ? styles.detailGridSingle : ""}`}>
        {visibleAssets.length ? <section><header><Laptop size={16} /><span><small>Equipment & access</small><h3>Asset register</h3></span></header>{visibleAssets.map((asset) => <div className={styles.assetRow} key={asset.id}><span><strong>{asset.item}</strong><small>{asset.owner}</small></span><span className={`${styles.statusPill} ${statusClass(asset.status)}`}>{asset.status}</span>{canActionRecord(asset.owner) && asset.status !== (selected.kind === "onboarding" ? "Issued" : "Returned") ? <button type="button" onClick={() => onAssetUpdate(selected.id, asset.id)}>{selected.kind === "onboarding" ? "Mark issued" : "Mark returned"}</button> : null}</div>)}</section> : null}
        {visibleAccess.length ? <section><header><ShieldCheck size={16} /><span><small>Role access</small><h3>Access & subscriptions</h3></span></header>{visibleAccess.map((request) => <div className={styles.accessRow} key={request.id}><span><strong>{request.service}</strong><small>{request.owner} · {request.businessNeed}</small><em>{request.renewal}</em></span><span className={`${styles.statusPill} ${statusClass(request.status)}`}>{request.status}</span>{canActionRecord(request.owner) && !["Active", "Revoked"].includes(request.status) ? <button type="button" onClick={() => onAccessUpdate(selected.id, request.id)}>{selected.kind === "offboarding" ? "Confirm revoked" : request.status === "Requested" ? "Approve" : "Advance"}</button> : null}</div>)}</section> : null}
      </div>{activeProfile.accessRole === "hr" ? <section className={styles.audit}><header><FileCheck2 size={16} /><span><small>Audit trail</small><h3>Recorded activity</h3></span></header>{selected.audit.slice(0, 5).map((entry) => <div key={entry.id}><span /><p><strong>{entry.actor}</strong> {entry.action}<small>{entry.time}</small></p></div>)}</section> : null}</div></details> : null}
    </article>
  </div>;
}

function CheckInsView({ people, reminders, selectedPerson, selectedPersonId, activeProfile, canManage, formsUrl, onSelectPerson, onComplete, onSnooze }: {
  people: CheckInPerson[];
  reminders: CheckInReminder[];
  selectedPerson?: CheckInPerson;
  selectedPersonId?: string;
  activeProfile: PeopleOperationsProfile;
  canManage: boolean;
  formsUrl?: string | null;
  onSelectPerson: (id: string) => void;
  onComplete: (id: string) => void;
  onSnooze: (id: string) => void;
}) {
  const personReminders = selectedPerson ? reminders.filter((reminder) => reminder.personId === selectedPerson.id).sort((first, second) => first.checkInDate.localeCompare(second.checkInDate) || first.notifyDate.localeCompare(second.notifyDate)) : [];
  const isEmployee = activeProfile.accessRole === "employee";
  const showPersonList = !isEmployee && people.length > 1;
  if (!people.length || !selectedPerson) return <div className={styles.emptyState}><CalendarClock size={26} /><strong>{isEmployee ? "No check-ins are scheduled for you" : "No check-ins yet"}</strong><span>{isEmployee ? "Your manager will add a milestone when needed." : "Schedule check-ins for someone in the organisation directory."}</span></div>;

  return <div className={styles.checkInDesk}><div className={`${styles.checkInLayout} ${!showPersonList ? styles.checkInLayoutSingle : ""}`}>
    {showPersonList ? <aside className={styles.personList} aria-label="Employee check-in register">{people.map((person) => <button type="button" key={person.id} className={person.id === selectedPersonId ? styles.personSelected : undefined} onClick={() => onSelectPerson(person.id)}><span className={styles.caseAvatar}>{initialsFor(person.name)}</span><span><strong>{person.name}</strong><small>{person.role} · Starts {formatDate(person.startDate)}</small></span><ChevronRight size={15} /></button>)}</aside> : null}
    <article className={styles.checkInDetail}><header><div>{!isEmployee ? <span className={styles.caseAvatar}>{initialsFor(selectedPerson.name)}</span> : null}<span><small>Check-in record</small><h2>{isEmployee ? "My check-ins" : selectedPerson.name}</h2><p>{selectedPerson.role}{selectedPerson.manager ? ` · Manager: ${selectedPerson.manager}` : ""}</p></span></div></header><div className={styles.checkInMeta}><div><small>Start date</small><strong>{formatDate(selectedPerson.startDate)}</strong></div>{selectedPerson.manager ? <div><small>Manager</small><strong>{selectedPerson.manager}</strong></div> : null}{canManage && formsUrl ? <a href={formsUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /> Forms & templates</a> : null}</div>
      <section className={styles.reminderTimeline}><header><span>Scheduled check-ins</span></header>{personReminders.map((reminder) => <article key={reminder.id}><span className={`${styles.timelineDot} ${statusClass(reminder.status)}`} /><div><strong>{reminder.milestone}{reminder.sequence === "Final" ? " · final reminder" : ""}</strong><p>Due {formatDate(reminder.checkInDate)} · reminder {formatDate(reminder.notifyDate)}</p>{reminder.snoozedUntil ? <small>Snoozed until {formatDate(reminder.snoozedUntil)}</small> : null}</div><span className={`${styles.statusPill} ${statusClass(reminder.status)}`}>{reminder.status}</span>{canManage && reminder.status !== "Completed" ? <span className={styles.reminderActions}><button type="button" onClick={() => onComplete(reminder.id)}>Complete</button><button type="button" onClick={() => onSnooze(reminder.id)}><RotateCcw size={13} /> Snooze</button></span> : null}</article>)}</section>
    </article>
  </div></div>;
}

function CreateCaseModal({ mode, profiles, onClose, onSubmit }: {
  mode: WorkflowKind | "checkin";
  profiles: OrganisationPerson[];
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const personSelectRef = useRef<HTMLSelectElement>(null);
  useDialogFocus(true, dialogRef, personSelectRef, onClose);
  const people = profiles
    .filter((profile) => profile.kind !== "org_unit" && profile.isActive !== false)
    .sort((first, second) => first.name.localeCompare(second.name));
  const label = mode === "onboarding" ? "onboarding" : mode === "offboarding" ? "offboarding" : "check-ins";
  const dateLabel = mode === "offboarding" ? "Final working day" : "Start date";
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="people-case-title" tabIndex={-1}><header><div><span>Tasks</span><h2 id="people-case-title">Start {label}</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={19} /></button></header><form onSubmit={onSubmit}>
    <label><span>Person</span><select ref={personSelectRef} name="personId" required defaultValue=""><option value="" disabled>Select from organisation</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.position}</option>)}</select></label>
    <label><span>{dateLabel}</span><input name="date" type="date" required /></label>
    <footer><button type="button" className={styles.cancelButton} onClick={onClose}>Cancel</button><button type="submit" className={styles.primaryAction}>Create <ArrowUpRight size={16} /></button></footer>
  </form></section></div>;
}
