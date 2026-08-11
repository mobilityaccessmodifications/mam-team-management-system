"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FileCheck2,
  HardHat,
  Laptop,
  Mail,
  Paperclip,
  Plus,
  RotateCcw,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { ChangeEvent, FormEvent, useMemo, useState } from "react";

import { AboutMeDemo } from "@/components/about-me-demo";
import styles from "@/components/people-operations-demo.module.css";

type AccessRole = "hr" | "manager" | "employee";
type PeopleSection = "profile" | "onboarding" | "offboarding" | "checkins";
type WorkflowKind = "onboarding" | "offboarding";
type TaskOwner = "HR" | "Team Leader" | "IT" | "Accounts" | "Analyst" | "Warehouse" | "Employee";
type TaskStatus = "Not Started" | "In Progress" | "Complete" | "Overdue";
type AssetStatus = "Required" | "Issued" | "Returned" | "Pending return";
type AccessStatus = "Requested" | "Approved" | "Provisioning" | "Active" | "Revocation due" | "Revoked";
type ReminderStatus = "Scheduled" | "Preview sent" | "Completed";

export type PeopleOperationsProfile = {
  name: string;
  initials: string;
  accessRole: AccessRole;
  roleLabel: string;
  team: string;
  manager: string;
  startedDate: string;
};

export type PeopleOperationsEmailPreview = {
  recipient: string;
  recipientName: string;
  subject: string;
  details: string[];
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

type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  time: string;
};

type PeopleWorkflow = {
  id: string;
  kind: WorkflowKind;
  employee: string;
  initials: string;
  role: string;
  department: string;
  manager: string;
  date: string;
  workEmail: string;
  status: string;
  tasks: WorkflowTask[];
  assets: WorkflowAsset[];
  access: AccessRequest[];
  audit: AuditEntry[];
};

type CheckInPerson = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  department: string;
  manager: string;
  address: string;
  dateOfBirth: string;
  mobile: string;
  email: string;
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
  sentAt?: string;
  snoozedUntil?: string;
};

const DEMO_TODAY = "2026-08-11";
const checkInFormsUrl = "https://mobilityaccessmodifications.sharepoint.com/sites/MAMOffice/Shared%20Documents?id=%2Fsites%2FMAMOffice%2FShared%20Documents%2F16%2E%20Recruitment%2FPROJECTS%2FCheck%20Ins&viewid=05d1cd50%2Df371%2D41fa%2D860f%2D2565b11018f4";
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
  const complete = workflow.tasks.filter((task) => task.status === "Complete").length;
  return Math.round((complete / workflow.tasks.length) * 100);
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
    { id: crypto.randomUUID(), group: "Equipment", title: "Desk, laptop, peripherals and mobile equipment ready", owner: "Warehouse", due: addDays(startDate, -3), status: "Not Started" },
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
    { id: crypto.randomUUID(), group: "Handover & close-out", title: "Final timesheet, optional exit interview and signed close-out", owner: "Accounts", due: addDays(endDate, 2), status: "Not Started" },
  ];
}

function createAssets(kind: WorkflowKind): WorkflowAsset[] {
  const issued = kind === "onboarding" ? "Issued" : "Pending return";
  return [
    { id: crypto.randomUUID(), item: "Laptop and peripherals", owner: "IT", status: issued },
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
    { id: crypto.randomUUID(), service: "Tool subscription", owner: "HR", businessNeed: offboarding ? "Revoke role-based access" : "Role-based business need", renewal: "Renewal to be confirmed", status: offboarding ? "Revocation due" : "Requested" },
  ];
}

const initialWorkflows: PeopleWorkflow[] = [
  {
    id: "OPS-ON-104",
    kind: "onboarding",
    employee: "Noah Williams",
    initials: "NW",
    role: "Project coordinator",
    department: "Major Modifications",
    manager: "Taylor Morgan",
    date: "2026-08-24",
    workEmail: "noah.williams@example.test",
    status: "In progress",
    tasks: [
      { id: "on-1", group: "HR documents", title: "Employee file and starter forms confirmed", owner: "HR", due: "2026-08-17", status: "Complete", evidence: "Starter-pack-confirmation.pdf" },
      { id: "on-2", group: "HR documents", title: "Induction lead, buddy and check-in schedule assigned", owner: "HR", due: "2026-08-19", status: "Complete" },
      { id: "on-3", group: "Equipment", title: "Laptop, dock, monitor and headset ready", owner: "Warehouse", due: "2026-08-21", status: "In Progress" },
      { id: "on-4", group: "Systems & access", title: "Payroll and Deputy request confirmed", owner: "Accounts", due: "2026-08-21", status: "Complete" },
      { id: "on-5", group: "Systems & access", title: "Microsoft and SharePoint access request", owner: "IT", due: "2026-08-22", status: "In Progress" },
      { id: "on-6", group: "Systems & access", title: "AroFlo, Hubstaff, 3CX and LMS access", owner: "Analyst", due: "2026-08-22", status: "Not Started" },
      { id: "on-7", group: "Pre-start & first day", title: "First-week plan, policies and key contacts shared", owner: "Team Leader", due: "2026-08-23", status: "Not Started" },
      { id: "on-8", group: "Pre-start & first day", title: "Tour, safety and role induction completed", owner: "Employee", due: "2026-08-24", status: "Not Started" },
    ],
    assets: [
      { id: "on-a1", item: "Laptop and peripherals", owner: "IT", status: "Issued" },
      { id: "on-a2", item: "Mobile and SIM", owner: "Team Leader", status: "Required" },
      { id: "on-a3", item: "Tools, PPE and uniform", owner: "Warehouse", status: "Required" },
      { id: "on-a4", item: "Vehicle or site access", owner: "Team Leader", status: "Required" },
    ],
    access: [
      { id: "on-x1", service: "Microsoft 365 & SharePoint", owner: "IT", businessNeed: "Email, files and role access", renewal: "Annual review", status: "Provisioning" },
      { id: "on-x2", service: "AroFlo, Deputy & Hubstaff", owner: "Analyst", businessNeed: "Roster, job and time access", renewal: "Role review", status: "Approved" },
      { id: "on-x3", service: "Tool subscription", owner: "HR", businessNeed: "Role-based business need", renewal: "Approval route to confirm", status: "Requested" },
    ],
    audit: [
      { id: "on-log-1", actor: "Priya Singh", action: "Created onboarding case and checklist template", time: "Today, 9:10 am" },
      { id: "on-log-2", actor: "Taylor Morgan", action: "Confirmed buddy and first-week plan", time: "Today, 10:05 am" },
    ],
  },
  {
    id: "OPS-OFF-027",
    kind: "offboarding",
    employee: "Alex King",
    initials: "AK",
    role: "Mobility consultant",
    department: "Major Modifications",
    manager: "Taylor Morgan",
    date: "2026-08-18",
    workEmail: "alex.king@example.test",
    status: "Needs attention",
    tasks: [
      { id: "off-1", group: "Exit confirmation", title: "Final working day and return expectations confirmed", owner: "HR", due: "2026-08-11", status: "Complete", evidence: "Exit-confirmation.pdf" },
      { id: "off-2", group: "Exit confirmation", title: "Offboarding brief issued to owners", owner: "Team Leader", due: "2026-08-12", status: "Complete" },
      { id: "off-3", group: "Systems & licences", title: "Microsoft mailbox and data retention decision", owner: "IT", due: "2026-08-16", status: "In Progress" },
      { id: "off-4", group: "Systems & licences", title: "AroFlo, Deputy, Hubstaff, 3CX, LMS and reporting cleanup", owner: "Analyst", due: "2026-08-17", status: "Not Started" },
      { id: "off-5", group: "Assets & physical access", title: "Confirm asset return plan and site access recovery", owner: "Warehouse", due: "2026-08-10", status: "Overdue" },
      { id: "off-6", group: "Handover & close-out", title: "Reassign jobs, files and inbox ownership", owner: "Team Leader", due: "2026-08-18", status: "In Progress" },
      { id: "off-7", group: "Handover & close-out", title: "Final timesheet and signed close-out", owner: "Accounts", due: "2026-08-20", status: "Not Started" },
    ],
    assets: [
      { id: "off-a1", item: "Laptop and peripherals", owner: "IT", status: "Pending return" },
      { id: "off-a2", item: "Mobile and SIM", owner: "Team Leader", status: "Returned" },
      { id: "off-a3", item: "Tools, PPE and uniform", owner: "Warehouse", status: "Pending return" },
      { id: "off-a4", item: "Vehicle or site access", owner: "Team Leader", status: "Pending return" },
    ],
    access: [
      { id: "off-x1", service: "Microsoft 365 & SharePoint", owner: "IT", businessNeed: "Remove access and choose data retention", renewal: "Close-out required", status: "Revocation due" },
      { id: "off-x2", service: "AroFlo, Deputy & Hubstaff", owner: "Analyst", businessNeed: "Disable and reclaim licences", renewal: "Close-out required", status: "Revocation due" },
      { id: "off-x3", service: "Tool subscription", owner: "HR", businessNeed: "Revoke role-based access", renewal: "Close-out required", status: "Revoked" },
    ],
    audit: [
      { id: "off-log-1", actor: "Priya Singh", action: "Created offboarding case and notified owners", time: "Yesterday, 3:20 pm" },
      { id: "off-log-2", actor: "Taylor Morgan", action: "Added current jobs for handover", time: "Today, 8:45 am" },
    ],
  },
];

const initialPeople: CheckInPerson[] = [
  {
    id: "person-noah",
    firstName: "Noah",
    lastName: "Williams",
    role: "Project coordinator",
    department: "Major Modifications",
    manager: "Taylor Morgan",
    address: "12 Example Street, Melbourne VIC",
    dateOfBirth: "1995-04-12",
    mobile: "0400 000 101",
    email: "noah.williams@example.test",
    startDate: "2026-07-30",
  },
  {
    id: "person-jordan",
    firstName: "Jordan",
    lastName: "Patel",
    role: "Estimator",
    department: "Major Modifications",
    manager: "Taylor Morgan",
    address: "45 Sample Road, Melbourne VIC",
    dateOfBirth: "1992-09-23",
    mobile: "0400 000 102",
    email: "jordan.patel@example.test",
    startDate: "2026-03-20",
  },
  {
    id: "person-mia",
    firstName: "Mia",
    lastName: "Chen",
    role: "Modifications coordinator",
    department: "Minor Modifications",
    manager: "Riley Brooks",
    address: "7 Fictional Lane, Melbourne VIC",
    dateOfBirth: "1996-11-03",
    mobile: "0400 000 103",
    email: "mia.chen@example.test",
    startDate: "2026-04-01",
  },
];

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

const initialReminders: CheckInReminder[] = [
  ...createCheckInReminders("person-noah", "2026-07-30"),
  ...createCheckInReminders("person-jordan", "2026-03-20").map<CheckInReminder>((reminder) => reminder.milestone === "5-month probation" && reminder.sequence === "Initial" ? { ...reminder, status: "Preview sent", sentAt: "6 Jul 2026" } : { ...reminder, status: "Completed" }),
  ...createCheckInReminders("person-mia", "2026-04-01").map<CheckInReminder>((reminder) => ({ ...reminder, status: "Completed" })),
];

function statusClass(status: string) {
  if (status === "Complete" || status === "Ready for Day 1" || status === "Offboarding complete" || status === "Active" || status === "Revoked" || status === "Completed") return styles.success;
  if (status === "Overdue" || status === "Needs attention" || status === "Revocation due") return styles.danger;
  if (status === "In Progress" || status === "Preview sent" || status === "Provisioning") return styles.progress;
  return styles.neutral;
}

function initialsFor(firstName: string, lastName: string) {
  return `${firstName.slice(0, 1)}${lastName.slice(0, 1)}`.toUpperCase();
}

export function PeopleOperationsDemo({
  activeProfile,
  onEmailPreview,
}: {
  activeProfile: PeopleOperationsProfile;
  onEmailPreview: (previews: PeopleOperationsEmailPreview[]) => void;
}) {
  const [section, setSection] = useState<PeopleSection>("profile");
  const [workflows, setWorkflows] = useState<PeopleWorkflow[]>(initialWorkflows);
  const [people, setPeople] = useState<CheckInPerson[]>(initialPeople);
  const [reminders, setReminders] = useState<CheckInReminder[]>(initialReminders);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("OPS-ON-104");
  const [selectedPersonId, setSelectedPersonId] = useState("person-noah");
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<WorkflowKind | "checkin">("onboarding");
  const [showPrivateFields, setShowPrivateFields] = useState(false);
  const [toast, setToast] = useState("");

  const canManage = activeProfile.accessRole === "hr" || activeProfile.accessRole === "manager";
  const canViewOffboarding = activeProfile.accessRole !== "employee";
  const accessibleWorkflows = useMemo(() => workflows.filter((workflow) => {
    if (workflow.kind === "offboarding" && !canViewOffboarding) return false;
    if (activeProfile.accessRole === "hr") return true;
    if (activeProfile.accessRole === "manager") return workflow.manager === activeProfile.name;
    return workflow.employee === activeProfile.name;
  }), [activeProfile, canViewOffboarding, workflows]);
  const visiblePeople = useMemo(() => people.filter((person) => {
    if (activeProfile.accessRole === "hr") return true;
    if (activeProfile.accessRole === "manager") return person.manager === activeProfile.name;
    return `${person.firstName} ${person.lastName}` === activeProfile.name;
  }), [activeProfile, people]);
  const visibleReminders = useMemo(() => reminders.filter((reminder) => visiblePeople.some((person) => person.id === reminder.personId)), [reminders, visiblePeople]);
  const visibleSection: PeopleSection = !canViewOffboarding && section === "offboarding" ? "profile" : section;
  const workflowSection: WorkflowKind = visibleSection === "offboarding" ? "offboarding" : "onboarding";
  const activeWorkflows = accessibleWorkflows.filter((workflow) => workflow.kind === workflowSection);
  const selectedWorkflow = activeWorkflows.find((workflow) => workflow.id === selectedWorkflowId) ?? activeWorkflows[0];
  const selectedPerson = visiblePeople.find((person) => person.id === selectedPersonId) ?? visiblePeople[0];
  const queuedReminders = visibleReminders.filter((reminder) => reminder.status === "Scheduled" && reminder.notifyDate <= DEMO_TODAY);

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function openCreate(mode: WorkflowKind | "checkin") {
    setCreateMode(mode);
    setShowCreate(true);
  }

  function updateTask(workflowId: string, taskId: string, nextStatus: TaskStatus, evidence?: string) {
    setWorkflows((current) => current.map((workflow) => {
      if (workflow.id !== workflowId) return workflow;
      const previousTask = workflow.tasks.find((task) => task.id === taskId);
      const nextTasks = workflow.tasks.map((task) => task.id === taskId ? { ...task, status: nextStatus, evidence: evidence ?? task.evidence } : task);
      const action = nextStatus === "Complete" ? `Confirmed “${previousTask?.title ?? "task"}”` : `Changed “${previousTask?.title ?? "task"}” to ${nextStatus}`;
      return { ...workflow, tasks: nextTasks, audit: [createAudit(activeProfile.name, action), ...workflow.audit] };
    }));
    announce(nextStatus === "Complete" ? "Task confirmed and added to the audit trail." : "Task status updated.");
  }

  function attachEvidence(event: ChangeEvent<HTMLInputElement>, workflowId: string, taskId: string) {
    const file = event.target.files?.[0];
    if (!file) return;
    updateTask(workflowId, taskId, "In Progress", file.name);
    announce(`${file.name} attached to this synthetic demo task.`);
    event.target.value = "";
  }

  function updateAsset(workflowId: string, assetId: string) {
    setWorkflows((current) => current.map((workflow) => {
      if (workflow.id !== workflowId) return workflow;
      const asset = workflow.assets.find((item) => item.id === assetId);
      const nextStatus: AssetStatus = workflow.kind === "onboarding" ? "Issued" : "Returned";
      return {
        ...workflow,
        assets: workflow.assets.map((item) => item.id === assetId ? { ...item, status: nextStatus } : item),
        audit: [createAudit(activeProfile.name, `Confirmed ${asset?.item ?? "asset"} as ${nextStatus.toLowerCase()}`), ...workflow.audit],
      };
    }));
    announce("Asset register updated.");
  }

  function updateAccess(workflowId: string, requestId: string) {
    setWorkflows((current) => current.map((workflow) => {
      if (workflow.id !== workflowId) return workflow;
      const currentRequest = workflow.access.find((request) => request.id === requestId);
      const nextStatus: AccessStatus = workflow.kind === "offboarding"
        ? "Revoked"
        : currentRequest?.status === "Requested" ? "Approved" : currentRequest?.status === "Approved" ? "Provisioning" : "Active";
      return {
        ...workflow,
        access: workflow.access.map((request) => request.id === requestId ? { ...request, status: nextStatus } : request),
        audit: [createAudit(activeProfile.name, `${currentRequest?.service ?? "Access request"} marked ${nextStatus.toLowerCase()}`), ...workflow.audit],
      };
    }));
    announce("Access register updated.");
  }

  function runDueReminders() {
    const due = queuedReminders;
    if (!due.length) {
      announce("No scheduled check-in reminders are due in this synthetic timeline.");
      return;
    }
    const previews = due.flatMap((reminder) => {
      const person = people.find((entry) => entry.id === reminder.personId);
      if (!person) return [];
      return [{
        recipient: "Team Leader",
        recipientName: person.manager,
        subject: `Check-in reminder — ${person.firstName} ${person.lastName} · ${reminder.milestone}`,
        details: [
          `Employee: ${person.firstName} ${person.lastName}`,
          `Role: ${person.role} · ${person.department}`,
          `Check-in due: ${formatDate(reminder.checkInDate)}`,
          `Reminder schedule: ${reminder.sequence.toLowerCase()} reminder on ${formatDate(reminder.notifyDate)}`,
          "Forms & templates: available from the People workspace",
          "Action: Schedule the check-in and use the MAM check-in / probation template.",
        ],
      }];
    });
    setReminders((current) => current.map((reminder) => due.some((entry) => entry.id === reminder.id) ? { ...reminder, status: "Preview sent", sentAt: "Just now" } : reminder));
    onEmailPreview(previews);
    announce(`${previews.length} email preview${previews.length === 1 ? "" : "s"} created.`);
  }

  function completeCheckIn(reminderId: string) {
    setReminders((current) => current.map((reminder) => reminder.id === reminderId ? { ...reminder, status: "Completed" } : reminder));
    announce("Check-in marked complete.");
  }

  function snoozeCheckIn(reminderId: string) {
    setReminders((current) => current.map((reminder) => reminder.id === reminderId ? { ...reminder, status: "Scheduled", sentAt: undefined, notifyDate: addDays(reminder.notifyDate, 7), snoozedUntil: addDays(reminder.notifyDate, 7) } : reminder));
    announce("Reminder moved one week later in this synthetic demo.");
  }

  function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const firstName = String(data.get("firstName") || "New").trim();
    const lastName = String(data.get("lastName") || "Starter").trim();
    const role = String(data.get("role") || "Team member").trim();
    const department = String(data.get("department") || activeProfile.team).trim();
    const manager = String(data.get("manager") || activeProfile.name).trim();
    const date = String(data.get("date") || DEMO_TODAY);
    const person: CheckInPerson = {
      id: crypto.randomUUID(),
      firstName,
      lastName,
      role,
      department,
      manager,
      address: String(data.get("address") || "Synthetic address only"),
      dateOfBirth: String(data.get("dateOfBirth") || "1990-01-01"),
      mobile: String(data.get("mobile") || "0400 000 000"),
      email: String(data.get("email") || `${firstName}.${lastName}@example.test`.toLowerCase()),
      startDate: createMode === "offboarding" ? DEMO_TODAY : date,
    };
    const existingPerson = people.find((entry) => entry.email === person.email);
    const checkInPerson = existingPerson ?? person;
    if (createMode !== "offboarding" && !existingPerson) setPeople((current) => [...current, person]);
    if (createMode !== "offboarding") setSelectedPersonId(checkInPerson.id);
    if (createMode === "checkin") {
      if (!existingPerson) setReminders((current) => [...createCheckInReminders(checkInPerson.id, date), ...current]);
      setSection("checkins");
      setShowCreate(false);
      announce(existingPerson ? `The existing synthetic check-in record for ${firstName} is selected.` : `Check-in register and the five reminder points were created for ${firstName}.`);
      return;
    }
    const kind = createMode;
    const id = `OPS-${kind === "onboarding" ? "ON" : "OFF"}-${String(workflows.length + 105).padStart(3, "0")}`;
    const workflow: PeopleWorkflow = {
      id,
      kind,
      employee: `${firstName} ${lastName}`,
      initials: initialsFor(firstName, lastName),
      role,
      department,
      manager,
      date,
      workEmail: person.email,
      status: "In progress",
      tasks: kind === "onboarding" ? createOnboardingTasks(date) : createOffboardingTasks(date),
      assets: createAssets(kind),
      access: createAccessRequests(kind),
      audit: [createAudit(activeProfile.name, `${kind === "onboarding" ? "Created onboarding" : "Created offboarding"} checklist from the MAM synthetic template`)],
    };
    setWorkflows((current) => [workflow, ...current]);
    if (kind === "onboarding" && !existingPerson) setReminders((current) => [...createCheckInReminders(checkInPerson.id, date), ...current]);
    setSection(kind);
    setSelectedWorkflowId(id);
    setShowCreate(false);
    announce(`${id} created with assigned tasks, assets, access requests${kind === "onboarding" ? " and check-in milestones" : ""}.`);
  }

  const actionableOwner = activeProfile.accessRole === "manager" ? "Team Leader" : activeProfile.accessRole === "employee" ? "Employee" : undefined;
  const totalOverdue = accessibleWorkflows.reduce((count, workflow) => count + workflow.tasks.filter((task) => task.status === "Overdue" && (!actionableOwner || task.owner === actionableOwner)).length, 0);

  return <section className={styles.workspace} aria-label="People operations workspace">
    <header className={styles.pageHeader}>
      <div>
        <h1>People</h1>
        {totalOverdue ? <p className={styles.attentionSummary}><AlertTriangle size={14} /> {totalOverdue} action{totalOverdue === 1 ? " needs" : "s need"} attention</p> : null}
      </div>
      {canManage && visibleSection !== "profile" ? <button className={styles.primaryAction} type="button" onClick={() => openCreate(visibleSection === "checkins" ? "checkin" : visibleSection)}><Plus size={17} /> {visibleSection === "checkins" ? "Add employee" : `Start ${visibleSection}`}</button> : null}
    </header>

    <nav className={styles.sectionSwitch} aria-label="People sections">
      <button type="button" aria-pressed={visibleSection === "profile"} className={visibleSection === "profile" ? styles.sectionActive : undefined} onClick={() => setSection("profile")}><span><strong>Profile</strong></span></button>
      <button type="button" aria-pressed={visibleSection === "onboarding"} className={visibleSection === "onboarding" ? styles.sectionActive : undefined} onClick={() => setSection("onboarding")}><span><strong>Onboarding</strong></span></button>
      <button type="button" aria-pressed={visibleSection === "checkins"} className={visibleSection === "checkins" ? styles.sectionActive : undefined} onClick={() => setSection("checkins")}><span><strong>Check-ins</strong></span>{queuedReminders.length ? <i>{queuedReminders.length}</i> : null}</button>
      {canViewOffboarding ? <button type="button" aria-pressed={visibleSection === "offboarding"} className={visibleSection === "offboarding" ? styles.sectionActive : undefined} onClick={() => setSection("offboarding")}><span><strong>Offboarding</strong></span></button> : null}
    </nav>

    {visibleSection === "profile" ? <AboutMeDemo roleLabel={activeProfile.roleLabel} team={activeProfile.team} manager={activeProfile.manager} startedDate={activeProfile.startedDate} /> : null}
    {visibleSection === "checkins" ? <CheckInsView
      people={visiblePeople}
      reminders={visibleReminders}
      selectedPerson={selectedPerson}
      selectedPersonId={selectedPerson?.id}
      activeProfile={activeProfile}
      showPrivateFields={showPrivateFields}
      canManage={canManage}
      onSelectPerson={(id) => { setSelectedPersonId(id); setShowPrivateFields(false); }}
      onRunDue={runDueReminders}
      onComplete={completeCheckIn}
      onSnooze={snoozeCheckIn}
      onTogglePrivate={() => setShowPrivateFields((current) => !current)}
    /> : null}
    {visibleSection === "onboarding" || visibleSection === "offboarding" ? <WorkflowsView
      workflows={activeWorkflows}
      selected={selectedWorkflow}
      selectedId={selectedWorkflow?.id}
      activeProfile={activeProfile}
      onSelect={setSelectedWorkflowId}
      onTaskUpdate={updateTask}
      onAttach={attachEvidence}
      onAssetUpdate={updateAsset}
      onAccessUpdate={updateAccess}
    /> : null}

    {showCreate ? <CreateCaseModal mode={createMode} defaultManager={activeProfile.name} defaultTeam={activeProfile.team} allowPrivateFields={activeProfile.accessRole === "hr"} onClose={() => setShowCreate(false)} onSubmit={createCase} /> : null}
    <div className={`${styles.toast} ${toast ? styles.toastVisible : ""}`} role="status" aria-live="polite"><CheckCircle2 size={16} />{toast}</div>
  </section>;
}

function WorkflowsView({
  workflows,
  selected,
  selectedId,
  activeProfile,
  onSelect,
  onTaskUpdate,
  onAttach,
  onAssetUpdate,
  onAccessUpdate,
}: {
  workflows: PeopleWorkflow[];
  selected?: PeopleWorkflow;
  selectedId?: string;
  activeProfile: PeopleOperationsProfile;
  onSelect: (id: string) => void;
  onTaskUpdate: (workflowId: string, taskId: string, status: TaskStatus) => void;
  onAttach: (event: ChangeEvent<HTMLInputElement>, workflowId: string, taskId: string) => void;
  onAssetUpdate: (workflowId: string, assetId: string) => void;
  onAccessUpdate: (workflowId: string, requestId: string) => void;
}) {
  if (!workflows.length || !selected) return <div className={styles.emptyState}><UsersRound size={26} /><strong>{activeProfile.accessRole === "employee" ? "No onboarding tasks are assigned to you." : "No matching workflows"}</strong><span>{activeProfile.accessRole === "employee" ? "Your assigned tasks will appear here." : "Start a synthetic workflow to see it here."}</span></div>;
  const isEmployee = activeProfile.accessRole === "employee";
  const visibleTasks = isEmployee ? selected.tasks.filter((task) => task.owner === "Employee") : selected.tasks;
  const groups = Array.from(new Set(visibleTasks.map((task) => task.group)));
  const visibleComplete = visibleTasks.filter((task) => task.status === "Complete").length;
  const progress = isEmployee ? Math.round((visibleComplete / Math.max(visibleTasks.length, 1)) * 100) : workflowProgress(selected);
  const visibleOverdue = isEmployee ? visibleTasks.filter((task) => task.status === "Overdue").length : workflowOverdueCount(selected);
  const status = isEmployee ? progress === 100 ? "Complete" : visibleOverdue ? "Needs attention" : "In progress" : workflowStatus(selected);
  const showWorkflowList = !isEmployee && workflows.length > 1;
  const canActionTask = (task: WorkflowTask) => activeProfile.accessRole === "hr" || (activeProfile.accessRole === "manager" && selected.manager === activeProfile.name && task.owner === "Team Leader") || (activeProfile.accessRole === "employee" && selected.employee === activeProfile.name && task.owner === "Employee");
  const canActionRecord = (owner: string) => activeProfile.accessRole === "hr" || (activeProfile.accessRole === "manager" && selected.manager === activeProfile.name && owner === "Team Leader");
  const visibleAssets = activeProfile.accessRole === "hr" ? selected.assets : selected.assets.filter((asset) => asset.owner === "Team Leader");
  const visibleAccess = activeProfile.accessRole === "hr" ? selected.access : selected.access.filter((request) => request.owner === "Team Leader");
  const showSupporting = activeProfile.accessRole !== "employee" && (activeProfile.accessRole === "hr" || visibleAssets.length > 0 || visibleAccess.length > 0);

  return <div className={`${styles.workflowDesk} ${!showWorkflowList ? styles.workflowDeskSingle : ""}`}>
    {showWorkflowList ? <aside className={styles.workflowList} aria-label="People workflow records">
      <header><span>{workflows.length} open</span><h2>{selected.kind === "onboarding" ? "New starters" : "Departures"}</h2></header>
      {workflows.map((workflow) => <button type="button" key={workflow.id} className={workflow.id === selectedId ? styles.workflowSelected : undefined} onClick={() => onSelect(workflow.id)}>
        <span className={styles.caseAvatar}>{workflow.initials}</span><span><small>{workflow.id}</small><strong>{workflow.employee}</strong><em>{workflow.role} · {workflow.department}</em></span><span className={`${styles.statusPill} ${statusClass(workflowStatus(workflow))}`}>{workflowProgress(workflow)}%</span><ChevronRight size={15} />
      </button>)}
    </aside> : null}

    <article className={styles.workflowDetail}>
      <header className={styles.detailHeader}>
        <div>{!isEmployee ? <span className={styles.caseAvatar}>{selected.initials}</span> : null}<span><small>{selected.id} · {selected.kind === "onboarding" ? "Onboarding" : "Offboarding"}</small><h2>{isEmployee ? "My onboarding" : selected.employee}</h2><p>{isEmployee ? `${selected.role} · ${selected.department}` : `${selected.role} · ${selected.department} · Manager: ${selected.manager}`}</p></span></div>
        <span className={`${styles.statusPill} ${statusClass(status)}`}>{status}</span>
      </header>

      <div className={styles.readiness}><div><span>{selected.kind === "onboarding" ? "Start date" : "Final working day"}</span><strong>{formatDate(selected.date)}</strong></div><div><span>{isEmployee ? "My progress" : "Checklist progress"}</span><strong>{progress}%</strong><i><b style={{ width: `${progress}%` }} /></i></div><div><span>Overdue actions</span><strong>{visibleOverdue}</strong></div></div>

      <section className={styles.taskBoard} aria-label="Assigned checklist">
        <header><h3>{selected.kind === "onboarding" ? "Onboarding tasks" : "Offboarding tasks"}</h3></header>
        {groups.map((group) => <div className={styles.taskGroup} key={group}><h4>{group}</h4>{visibleTasks.filter((task) => task.group === group).map((task) => <div className={styles.taskRow} key={task.id}>
          <span className={`${styles.taskMark} ${task.status === "Complete" ? styles.taskComplete : ""}`}>{task.status === "Complete" ? <Check size={14} /> : <CircleDot size={13} />}</span>
          <span><strong>{task.title}</strong><small>{task.owner} · Due {formatDate(task.due)}{task.evidence ? " · Attachment added" : ""}</small></span>
          <span className={`${styles.statusPill} ${statusClass(task.status)}`}>{task.status}</span>
          {canActionTask(task) ? <span className={styles.taskActions}><label title="Attach a synthetic confirmation"><Paperclip size={14} /> Attach<input type="file" accept="application/pdf,image/*" onChange={(event) => onAttach(event, selected.id, task.id)} /></label><button type="button" onClick={() => onTaskUpdate(selected.id, task.id, task.status === "Complete" ? "In Progress" : "Complete")}>{task.status === "Complete" ? "Reopen" : "Confirm"}</button></span> : null}
        </div>)}</div>)}
      </section>

      {showSupporting ? <details className={styles.supportingDetails}>
        <summary><span>{activeProfile.accessRole === "hr" ? "Assets, access and activity" : "Assets and access"}</span><small>Open when needed</small></summary>
        <div className={styles.supportingContent}>
          <div className={`${styles.detailGrid} ${visibleAssets.length && !visibleAccess.length ? styles.detailGridSingle : ""}`}>
            {visibleAssets.length ? <section><header><Laptop size={16} /><span><small>Equipment & access</small><h3>Asset register</h3></span></header>{visibleAssets.map((asset) => <div className={styles.assetRow} key={asset.id}><span><strong>{asset.item}</strong><small>{asset.owner}</small></span><span className={`${styles.statusPill} ${statusClass(asset.status)}`}>{asset.status}</span>{canActionRecord(asset.owner) && asset.status !== (selected.kind === "onboarding" ? "Issued" : "Returned") ? <button type="button" onClick={() => onAssetUpdate(selected.id, asset.id)}>{selected.kind === "onboarding" ? "Mark issued" : "Mark returned"}</button> : null}</div>)}</section> : null}
            {visibleAccess.length ? <section><header><ShieldCheck size={16} /><span><small>Role access</small><h3>Access & subscriptions</h3></span></header>{visibleAccess.map((request) => <div className={styles.accessRow} key={request.id}><span><strong>{request.service}</strong><small>{request.owner} · {request.businessNeed}</small><em>{request.renewal}</em></span><span className={`${styles.statusPill} ${statusClass(request.status)}`}>{request.status}</span>{canActionRecord(request.owner) && !["Active", "Revoked"].includes(request.status) ? <button type="button" onClick={() => onAccessUpdate(selected.id, request.id)}>{selected.kind === "offboarding" ? "Confirm revoked" : request.status === "Requested" ? "Approve" : "Advance"}</button> : null}</div>)}</section> : null}
          </div>

          {activeProfile.accessRole === "hr" ? <section className={styles.audit}><header><FileCheck2 size={16} /><span><small>Audit trail</small><h3>Recorded activity</h3></span></header>{selected.audit.slice(0, 5).map((entry) => <div key={entry.id}><span /><p><strong>{entry.actor}</strong> {entry.action}<small>{entry.time}</small></p></div>)}</section> : null}
        </div>
      </details> : null}
    </article>
  </div>;
}

function CheckInsView({
  people,
  reminders,
  selectedPerson,
  selectedPersonId,
  activeProfile,
  showPrivateFields,
  canManage,
  onSelectPerson,
  onRunDue,
  onComplete,
  onSnooze,
  onTogglePrivate,
}: {
  people: CheckInPerson[];
  reminders: CheckInReminder[];
  selectedPerson?: CheckInPerson;
  selectedPersonId?: string;
  activeProfile: PeopleOperationsProfile;
  showPrivateFields: boolean;
  canManage: boolean;
  onSelectPerson: (id: string) => void;
  onRunDue: () => void;
  onComplete: (id: string) => void;
  onSnooze: (id: string) => void;
  onTogglePrivate: () => void;
}) {
  const personReminders = selectedPerson ? reminders.filter((reminder) => reminder.personId === selectedPerson.id).sort((first, second) => first.checkInDate.localeCompare(second.checkInDate) || first.notifyDate.localeCompare(second.notifyDate)) : [];
  const dueCount = reminders.filter((reminder) => reminder.status === "Scheduled" && reminder.notifyDate <= DEMO_TODAY).length;
  const isEmployee = activeProfile.accessRole === "employee";
  const showPersonList = !isEmployee && people.length > 1;
  if (!people.length || !selectedPerson) return <div className={styles.emptyState}><CalendarClock size={26} /><strong>{activeProfile.accessRole === "employee" ? "No check-ins are scheduled for you." : "No matching check-in records"}</strong><span>{activeProfile.accessRole === "employee" ? "Your manager will add the next milestone when it is needed." : "Add a fictional employee to the check-in register."}</span></div>;

  return <div className={styles.checkInDesk}>
    {canManage ? <header className={styles.checkInLead}><p>{dueCount ? `${dueCount} reminder${dueCount === 1 ? "" : "s"} due` : "No reminders due"}</p><button className={styles.previewButton} type="button" onClick={onRunDue} disabled={!dueCount}><Mail size={16} /> Create {dueCount || ""} email preview{dueCount === 1 ? "" : "s"}</button></header> : null}
    <div className={`${styles.checkInLayout} ${!showPersonList ? styles.checkInLayoutSingle : ""}`}>
      {showPersonList ? <aside className={styles.personList} aria-label="Employee check-in register">
        {people.map((person) => <button type="button" key={person.id} className={person.id === selectedPersonId ? styles.personSelected : undefined} onClick={() => onSelectPerson(person.id)}><span className={styles.caseAvatar}>{initialsFor(person.firstName, person.lastName)}</span><span><strong>{person.firstName} {person.lastName}</strong><small>{person.role} · Starts {formatDate(person.startDate)}</small></span><ChevronRight size={15} /></button>)}
      </aside> : null}
      <article className={styles.checkInDetail}>
        <header><div>{!isEmployee ? <span className={styles.caseAvatar}>{initialsFor(selectedPerson.firstName, selectedPerson.lastName)}</span> : null}<span><small>Check-in record</small><h2>{isEmployee ? "My check-ins" : `${selectedPerson.firstName} ${selectedPerson.lastName}`}</h2><p>{isEmployee ? selectedPerson.role : `${selectedPerson.role} · ${selectedPerson.department} · Manager: ${selectedPerson.manager}`}</p></span></div>{activeProfile.accessRole === "hr" ? <button type="button" className={styles.detailToggle} onClick={onTogglePrivate}>{showPrivateFields ? "Hide HR fields" : "View HR fields"}</button> : null}</header>
        {showPrivateFields && activeProfile.accessRole === "hr" ? <div className={styles.privateFields}><ShieldCheck size={16} /><span><strong>HR-only synthetic register fields</strong><small>Address: {selectedPerson.address} · DOB: {formatDate(selectedPerson.dateOfBirth)} · Mobile: {selectedPerson.mobile} · Email: {selectedPerson.email}</small></span></div> : null}
        <div className={styles.checkInMeta}><div><small>Start date</small><strong>{formatDate(selectedPerson.startDate)}</strong></div><div><small>Manager</small><strong>{selectedPerson.manager}</strong></div>{canManage ? <a href={checkInFormsUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /> Forms & templates</a> : null}</div>
        <section className={styles.reminderTimeline}><header><span>Scheduled check-ins</span></header>{personReminders.map((reminder) => <article key={reminder.id}><span className={`${styles.timelineDot} ${statusClass(reminder.status)}`} /><div><strong>{reminder.milestone}{reminder.sequence === "Final" ? " · final reminder" : ""}</strong><p>Due {formatDate(reminder.checkInDate)} · reminder {formatDate(reminder.notifyDate)}</p>{reminder.snoozedUntil ? <small>Snoozed until {formatDate(reminder.snoozedUntil)}</small> : null}{reminder.sentAt ? <small>Email preview created {reminder.sentAt}</small> : null}</div><span className={`${styles.statusPill} ${statusClass(reminder.status)}`}>{reminder.status === "Preview sent" ? "Preview created" : reminder.status}</span>{canManage && !["Completed"].includes(reminder.status) ? <span className={styles.reminderActions}><button type="button" onClick={() => onComplete(reminder.id)}>Complete</button><button type="button" onClick={() => onSnooze(reminder.id)}><RotateCcw size={13} /> Snooze</button></span> : null}</article>)}</section>
      </article>
    </div>
  </div>;
}

function CreateCaseModal({
  mode,
  defaultManager,
  defaultTeam,
  allowPrivateFields,
  onClose,
  onSubmit,
}: {
  mode: WorkflowKind | "checkin";
  defaultManager: string;
  defaultTeam: string;
  allowPrivateFields: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const label = mode === "onboarding" ? "onboarding case" : mode === "offboarding" ? "offboarding case" : "check-in record";
  const dateLabel = mode === "offboarding" ? "Final working day" : "Start date";
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="people-case-title">
      <header><div><span>Synthetic People workflow</span><h2 id="people-case-title">Start {label}</h2></div><button type="button" onClick={onClose} aria-label="Close"><X size={19} /></button></header>
      <p className={styles.modalNotice}><HardHat size={16} /> Demo only — use fictional details.</p>
      <form onSubmit={onSubmit}>
        <div className={styles.formRow}><label><span>First name</span><input name="firstName" defaultValue="Casey" required /></label><label><span>Last name</span><input name="lastName" defaultValue="Nguyen" required /></label></div>
        <div className={styles.formRow}><label><span>Role</span><input name="role" defaultValue="Team coordinator" required /></label><label><span>Department</span><input name="department" defaultValue={defaultTeam} required /></label></div>
        <div className={styles.formRow}><label><span>Manager</span><input name="manager" defaultValue={defaultManager} required /></label><label><span>{dateLabel}</span><input name="date" type="date" defaultValue={mode === "offboarding" ? "2026-09-04" : "2026-09-01"} required /></label></div>
        {allowPrivateFields ? <details><summary>HR register fields <small>Synthetic only</small></summary><div className={styles.formRow}><label><span>Address</span><input name="address" defaultValue="99 Example Avenue, Melbourne VIC" /></label><label><span>Date of birth</span><input name="dateOfBirth" type="date" defaultValue="1994-06-15" /></label></div><label><span>Mobile</span><input name="mobile" defaultValue="0400 000 199" /></label></details> : null}
        <footer><button type="button" className={styles.cancelButton} onClick={onClose}>Cancel</button><button type="submit" className={styles.primaryAction}>Create {label} <ArrowUpRight size={16} /></button></footer>
      </form>
    </section>
  </div>;
}
