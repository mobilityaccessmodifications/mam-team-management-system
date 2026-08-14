"use client";

import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  Eye,
  FileImage,
  FileText,
  LayoutDashboard,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  LogOut,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import {
  createPortalAccount,
  listPortalAccounts,
  resetPortalPassword,
  togglePortalAccount,
  updatePortalLogin,
} from "@/app/accounts/actions";
import { signOut } from "@/app/login/actions";
import {
  AccountManagement,
  type AccountDto,
} from "@/components/account-management";
import { EmployeeDirectory } from "@/components/employee-directory";
import styles from "@/components/leave-demo.module.css";
import { PeopleOperationsDemo } from "@/components/people-operations-demo";
import type {
  OrganisationCompany,
  OrganisationPerson,
  OrganisationPersonDraft,
} from "@/components/organisation-tree";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

type AppView = "home" | "leave" | "calendar" | "people";
type LeaveSection = "requests" | "approvals";
type RequestStatus = "Pending" | "Approved" | "Declined";
type AccessRole = "hr" | "manager" | "employee";
type PreviewAccessRole = Exclude<AccessRole, "hr">;

type LeaveRequest = {
  id: string;
  employee: string;
  initials: string;
  team: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  dateLabel: string;
  days: number;
  hours?: number;
  startTime?: string;
  endTime?: string;
  approvalRequired: boolean;
  status: RequestStatus;
  submittedAt: string;
  manager: string;
  employeeNote: string;
  managerNote?: string;
  attachments?: LeaveAttachment[];
};

type LeaveAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
};

type Profile = {
  id: string;
  name: string;
  initials: string;
  accessRole: AccessRole;
  roleLabel: string;
  team: string;
  manager: string;
  company: OrganisationCompany;
};

type InternalOrgRow = {
  id: string;
  node_kind: "person" | "org_unit" | "vacancy";
  company_key: OrganisationCompany;
  full_name: string | null;
  position_title: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  updated_at: string;
  version: number;
};

type DirectoryState = "connecting" | "live" | "error";

type InitialNavigation = {
  view: AppView;
  section: LeaveSection;
  requestId?: string;
};

/* Leave requests stay in this browser session until the production workflow is confirmed. */
const initialRequests: LeaveRequest[] = [];

function businessDaysBetween(start: string, end: string) {
  const first = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  let days = 0;
  for (const current = new Date(first); current <= last; current.setDate(current.getDate() + 1)) {
    if (current.getDay() !== 0 && current.getDay() !== 6) days += 1;
  }
  return days;
}

function isWeekday(date: string) {
  const day = new Date(`${date}T12:00:00`).getDay();
  return day !== 0 && day !== 6;
}

function minutesFromTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours * 60) + minutes;
}

function workingHoursBetween(startDate: string, endDate: string, startTime: string, endTime: string) {
  const first = new Date(`${startDate}T12:00:00`);
  const last = new Date(`${endDate}T12:00:00`);
  const selectedStart = minutesFromTime(startTime);
  const selectedEnd = minutesFromTime(endTime);
  let minutes = 0;

  for (const current = new Date(first); current <= last; current.setDate(current.getDate() + 1)) {
    if (current.getDay() === 0 || current.getDay() === 6) continue;
    const currentDate = toIsoDate(current);
    const dayStart = currentDate === startDate ? selectedStart : 6 * 60;
    const dayEnd = currentDate === endDate ? selectedEnd : 18 * 60;
    minutes += Math.max(0, dayEnd - dayStart);
  }

  return Math.round((minutes / 60) * 100) / 100;
}

function formatDuration(request: LeaveRequest) {
  if (request.hours) return `${request.hours} ${request.hours === 1 ? "hour" : "hours"}`;
  return `${request.days} ${request.days === 1 ? "day" : "days"}`;
}

function formatClockTime(value: string) {
  const [hourValue, minute] = value.split(":");
  const hour = Number(hourValue);
  const suffix = hour >= 12 ? "pm" : "am";
  return `${hour % 12 || 12}:${minute} ${suffix}`;
}

function formatTimeRange(request: LeaveRequest) {
  if (!request.startTime || !request.endTime) return "";
  if (request.startDate !== request.endDate) {
    return `First day from ${formatClockTime(request.startTime)} · last day until ${formatClockTime(request.endTime)}`;
  }
  return `${formatClockTime(request.startTime)}–${formatClockTime(request.endTime)}`;
}

function formatDurationWithTime(request: LeaveRequest) {
  const timeRange = formatTimeRange(request);
  return timeRange ? `${formatDuration(request)} · ${timeRange}` : formatDuration(request);
}

const TIME_OPTIONS = Array.from({ length: 49 }, (_, index) => {
  const totalMinutes = (6 * 60) + (index * 15);
  const value = `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  return { value, label: formatClockTime(value) };
});

const START_TIME_OPTIONS = TIME_OPTIONS.slice(0, -1);
const END_TIME_OPTIONS = TIME_OPTIONS.slice(1);
const TIME_VALUES = new Set(TIME_OPTIONS.map((option) => option.value));
const MAX_ATTACHMENT_COUNT = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateRange(start: string, end: string) {
  const date = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" });
  const year = new Intl.DateTimeFormat("en-AU", { year: "numeric" });
  const first = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  if (start === end) return `${date.format(first)} ${year.format(last)}`;
  if (first.getMonth() === last.getMonth()) return `${first.getDate()}–${date.format(last)} ${year.format(last)}`;
  return `${date.format(first)}–${date.format(last)} ${year.format(last)}`;
}

function toIsoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getApprovalCalendarDays(request: LeaveRequest) {
  const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const first = new Date(`${request.startDate}T12:00:00`);
  const last = new Date(`${request.endDate}T12:00:00`);
  first.setDate(first.getDate() - 21);
  last.setDate(last.getDate() + 21);

  const firstWeekday = first.getDay();
  first.setDate(first.getDate() - (firstWeekday === 0 ? 6 : firstWeekday - 1));
  const lastWeekday = last.getDay();
  last.setDate(last.getDate() + (lastWeekday === 0 ? 0 : 7 - lastWeekday));

  const dayCount = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  return Array.from({ length: dayCount }, (_, index) => {
    const current = new Date(first);
    current.setDate(first.getDate() + index);
    return {
      iso: toIsoDate(current),
      day: current.getDate(),
      month: shortMonths[current.getMonth()],
      isWeekend: current.getDay() === 0 || current.getDay() === 6,
    };
  });
}

function requestsOverlap(first: LeaveRequest, second: LeaveRequest) {
  if (first.endDate < second.startDate || second.endDate < first.startDate) return false;

  const sharedStart = first.startDate > second.startDate ? first.startDate : second.startDate;
  const sharedEnd = first.endDate < second.endDate ? first.endDate : second.endDate;
  if (sharedStart !== sharedEnd) return true;

  const firstIsPartial = first.startDate === first.endDate && first.startTime && first.endTime;
  const secondIsPartial = second.startDate === second.endDate && second.startTime && second.endTime;
  if (!firstIsPartial || !secondIsPartial) return true;

  return first.startTime! < second.endTime! && second.startTime! < first.endTime!;
}

function getCalendarDays() {
  const first = new Date("2026-07-27T12:00:00");
  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(first);
    current.setDate(first.getDate() + index);
    return {
      iso: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`,
      day: current.getDate(),
      inMonth: current.getMonth() === 7,
    };
  });
}

function getViewTitles(profile: Profile): Record<Exclude<AppView, "people">, { title: string; helper?: string }> {
  return {
    home: { title: "Home" },
    leave: { title: profile.accessRole === "employee" ? "My leave" : "Leave" },
    calendar: { title: "Team calendar", helper: "August 2026" },
  };
}

function getVisibleRequests(requests: LeaveRequest[], profile: Profile) {
  if (profile.accessRole === "hr") return requests;
  if (profile.accessRole === "manager") {
    return requests.filter((request) => request.manager === profile.name || request.employee === profile.name);
  }
  return requests.filter((request) => request.employee === profile.name);
}

function getCalendarRequests(requests: LeaveRequest[], profile: Profile) {
  if (profile.accessRole === "hr") return requests;
  return requests.filter((request) => request.team === profile.team);
}

function getPreviewRequests(requests: LeaveRequest[], profile: Profile) {
  if (profile.accessRole === "manager") {
    return requests.filter((request) => request.manager === profile.name || request.employee === profile.name);
  }
  return requests.filter((request) => request.employee === profile.name);
}

function initialsForName(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function accessRoleForOrgPerson(row: InternalOrgRow, managerIds: Set<string>): AccessRole {
  if (/\bHR\b|PEOPLE\s*&\s*CULTURE/i.test(row.position_title)) return "hr";
  return managerIds.has(row.id) ? "manager" : "employee";
}

function previewAccessRoleForOrgPerson(personId: string, rows: InternalOrgRow[]): PreviewAccessRole {
  return rows.some((row) => row.is_active && row.parent_id === personId)
    ? "manager"
    : "employee";
}

export function LeaveDemo({
  initialNavigation,
  isAdmin = false,
  currentPersonId,
}: {
  initialNavigation?: InitialNavigation;
  isAdmin?: boolean;
  currentPersonId?: string;
}) {
  const directorySupabase = isSupabaseConfigured() ? createClient() : null;
  const [activeView, setActiveView] = useState<AppView>(initialNavigation?.view ?? "home");
  const [requests, setRequests] = useState<LeaveRequest[]>(initialRequests);
  const [selectedRequestId, setSelectedRequestId] = useState(initialNavigation?.requestId ?? "");
  const [leaveSection, setLeaveSection] = useState<LeaveSection>(initialNavigation?.section ?? "requests");
  const [statusFilter, setStatusFilter] = useState<"All" | RequestStatus>("All");
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [managerNote, setManagerNote] = useState("");
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");
  const [isMutating, setIsMutating] = useState(false);
  const [organisationRows, setOrganisationRows] = useState<InternalOrgRow[]>([]);
  const [canEditOrganisation, setCanEditOrganisation] = useState(false);
  const [canManageEmployeeDirectory, setCanManageEmployeeDirectory] = useState(false);
  const [employeeDirectoryRefreshKey, setEmployeeDirectoryRefreshKey] = useState(0);
  const [employeeDirectorySelectedPersonId, setEmployeeDirectorySelectedPersonId] = useState<string | null>(null);
  const [organisationState, setOrganisationState] = useState<DirectoryState>("connecting");
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [accountsError, setAccountsError] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  // This is intentionally UI-only. It never changes the authenticated user or
  // the capability checks that protect HR records and organisation writes.
  const [previewPersonId, setPreviewPersonId] = useState("");

  const loadAccounts = useCallback(async () => {
    if (!isAdmin || !canManageEmployeeDirectory) {
      setAccounts([]);
      setAccountsError("");
      setAccountsLoading(false);
      return;
    }
    setAccountsLoading(true);
    try {
      setAccounts(await listPortalAccounts());
      setAccountsError("");
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : "Accounts could not be loaded.");
    } finally {
      setAccountsLoading(false);
    }
  }, [canManageEmployeeDirectory, isAdmin]);

  const loadOrganisation = useCallback(async () => {
    if (!directorySupabase) return;
    const [{ data: rows, error }, { data: canEdit }, { data: canManageEmployeeDirectory }] = await Promise.all([
      directorySupabase
        .from("internal_org_people")
        .select("id,node_kind,company_key,full_name,position_title,parent_id,sort_order,is_active,updated_at,version")
        .order("sort_order", { ascending: true })
        .order("position_title", { ascending: true }),
      directorySupabase.rpc("can_edit_internal_org"),
      directorySupabase.rpc("can_manage_employee_directory"),
    ]);

    if (error) {
      setOrganisationState("error");
      return;
    }
    setOrganisationRows((rows ?? []) as InternalOrgRow[]);
    setCanEditOrganisation(canEdit === true);
    setCanManageEmployeeDirectory(canManageEmployeeDirectory === true);
    setOrganisationState("live");
  }, [directorySupabase]);

  useEffect(() => {
    if (!directorySupabase) return;
    let mounted = true;
    let refreshTimer: number | undefined;
    refreshTimer = window.setTimeout(() => void loadOrganisation(), 0);
    const channel = directorySupabase
      .channel("internal:organisation")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "internal_org_people",
          select: ["id", "version"],
        },
        () => {
          if (!mounted) return;
          setEmployeeDirectoryRefreshKey((current) => current + 1);
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void loadOrganisation(), 120);
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      window.clearTimeout(refreshTimer);
      void directorySupabase.removeChannel(channel);
    };
  }, [directorySupabase, loadOrganisation]);

  useEffect(() => {
    if (!isAdmin || !canManageEmployeeDirectory) return;
    const timer = window.setTimeout(() => void loadAccounts(), 0);
    return () => window.clearTimeout(timer);
  }, [canManageEmployeeDirectory, isAdmin, loadAccounts]);

  const organisationPeople = useMemo<OrganisationPerson[]>(() => organisationRows
    .filter((row) => row.node_kind !== "vacancy")
    .map((row) => ({
      id: row.id,
      name: row.node_kind === "org_unit" ? row.position_title : row.full_name ?? "Unnamed person",
      position: row.node_kind === "org_unit" ? "" : row.position_title,
      company: row.company_key,
      reportsTo: row.parent_id,
      kind: row.node_kind === "org_unit" ? "org_unit" : "person",
      sortOrder: row.sort_order,
      isActive: row.is_active,
    })), [organisationRows]);
  const directoryProfiles = useMemo<Profile[]>(() => {
    const rowsById = new Map(organisationRows.map((row) => [row.id, row]));
    const managerIds = new Set(organisationRows
      .filter((row) => row.is_active)
      .map((row) => row.parent_id)
      .filter((id): id is string => Boolean(id)));
    const managerFor = (row: InternalOrgRow) => {
      const visited = new Set<string>();
      let parentId = row.parent_id;
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = rowsById.get(parentId);
        if (!parent) return "";
        if (parent.node_kind === "person" && parent.is_active) return parent.full_name ?? "";
        parentId = parent.parent_id;
      }
      return "";
    };
    return organisationRows
      .filter((row) => row.node_kind === "person" && row.is_active && row.full_name)
      .map((row) => {
        return {
          id: row.id,
          name: row.full_name ?? "Unnamed person",
          initials: initialsForName(row.full_name ?? ""),
          accessRole: accessRoleForOrgPerson(row, managerIds),
          roleLabel: row.position_title,
          team: row.company_key === "mam" ? "MAM" : "Equipsy",
          manager: managerFor(row),
          company: row.company_key,
        };
      });
  }, [organisationRows]);
  const signedInProfile = directoryProfiles.find((profile) => profile.id === currentPersonId);
  if (!signedInProfile) {
    return <DirectoryLoading state={organisationState} />;
  }
  const adminProfile: Profile = canManageEmployeeDirectory
    ? { ...signedInProfile, accessRole: "hr" }
    : signedInProfile;
  const canPreviewEmployeeAccess = isAdmin && canManageEmployeeDirectory;
  const previewCandidate = canPreviewEmployeeAccess && previewPersonId
    ? directoryProfiles.find((profile) => profile.id === previewPersonId)
    : undefined;
  // A preview is never an HR presentation. HR is an actual database capability,
  // while manager presentation is derived only from active direct reports.
  const previewProfile: Profile | undefined = previewCandidate
    ? {
        ...previewCandidate,
        accessRole: previewAccessRoleForOrgPerson(previewCandidate.id, organisationRows),
      }
    : undefined;
  const isPreviewingEmployeeAccess = Boolean(previewProfile);
  const activeProfile = previewProfile ?? adminProfile;
  const showHrWorkspace = canManageEmployeeDirectory && !isPreviewingEmployeeAccess;

  const viewTitles = getViewTitles(activeProfile);
  const visibleRequests = isPreviewingEmployeeAccess
    ? getPreviewRequests(requests, activeProfile)
    : getVisibleRequests(requests, activeProfile);
  const calendarRequests = isPreviewingEmployeeAccess
    ? getPreviewRequests(requests, activeProfile)
    : getCalendarRequests(requests, activeProfile);
  const approvalQueue = activeProfile.accessRole === "manager"
    ? requests.filter((request) => request.approvalRequired && request.status === "Pending" && request.manager === activeProfile.name)
    : [];
  const myRequests = requests.filter((request) => request.employee === activeProfile.name);
  const filteredRequests = visibleRequests.filter((request) => {
    return statusFilter === "All" || request.status === statusFilter;
  });
  const selectedRegisterRequest = filteredRequests.find((request) => request.id === selectedRequestId) ?? filteredRequests[0];
  const selectedApprovalRequest = approvalQueue.find((request) => request.id === selectedRequestId) ?? approvalQueue[0];
  const selectedRequest = leaveSection === "approvals" ? selectedApprovalRequest : selectedRegisterRequest;

  async function createOrganisationPerson(person: OrganisationPersonDraft) {
    if (!directorySupabase) throw new Error("The directory is not connected.");
    const { error } = await directorySupabase.rpc("create_internal_org_node", {
      p_company_key: person.company,
      p_node_kind: "person",
      p_position_title: person.position,
      p_full_name: person.name,
      p_parent_id: person.reportsTo,
      p_started_date: null,
      p_sort_order: organisationRows.length + 1,
    });
    if (error) throw new Error(error.message);
    await Promise.all([loadOrganisation(), loadAccounts()]);
    announce(`${person.name} added to the organisation.`);
  }

  async function updateOrganisationPerson(id: string, person: OrganisationPersonDraft) {
    if (!directorySupabase) throw new Error("The directory is not connected.");
    const current = organisationRows.find((row) => row.id === id);
    if (!current) throw new Error("This person is no longer in the directory.");
    const { error } = await directorySupabase.rpc("update_internal_org_node", {
      p_node_id: id,
      p_company_key: person.company,
      p_node_kind: "person",
      p_position_title: person.position,
      p_full_name: person.name,
      p_parent_id: person.reportsTo,
      p_started_date: null,
      p_sort_order: current.sort_order,
      p_is_active: true,
      p_expected_version: current.version,
    });
    if (error) throw new Error(error.message);
    await Promise.all([loadOrganisation(), loadAccounts()]);
    announce(`${person.name}'s profile was updated.`);
  }

  function updateAccountRecord(account: AccountDto) {
    setAccounts((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.personId === account.personId);
      if (existingIndex < 0) return [...current, account];
      return current.map((candidate) => candidate.personId === account.personId ? account : candidate);
    });
  }

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function changeEmployeeAccessPreview(personId: string) {
    const nextProfile = directoryProfiles.find((profile) => profile.id === personId);
    setPreviewPersonId(nextProfile?.id ?? "");
    setShowRequestForm(false);
    setFormError("");
    setManagerNote("");
    setSelectedRequestId("");
    setLeaveSection("requests");

    if (nextProfile) {
      announce(`Previewing ${nextProfile.name}'s employee access. HR tools and private records are hidden.`);
    } else {
      announce("Returned to the HR workspace.");
    }
  }

  function chooseLeaveSection(section: LeaveSection, requestedId?: string) {
    if (section === "approvals" && activeProfile.accessRole !== "manager") return;
    if (section === "approvals" && approvalQueue[0]) {
      const nextId = requestedId && approvalQueue.some((request) => request.id === requestedId)
        ? requestedId
        : approvalQueue.some((request) => request.id === selectedRequestId)
          ? selectedRequestId
          : approvalQueue[0].id;
      setSelectedRequestId(nextId);
    }
    setLeaveSection(section);
  }

  function navigate(view: AppView, section?: LeaveSection) {
    if (view === "leave") chooseLeaveSection(section ?? "requests");
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function selectRequest(id: string, section: LeaveSection = "requests") {
    setSelectedRequestId(id);
    setManagerNote("");
    chooseLeaveSection(section, id);
    setActiveView("leave");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isMutating || isPreviewingEmployeeAccess) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const leaveType = String(data.get("leaveType"));
    const startDate = String(data.get("startDate"));
    const endDate = String(data.get("endDate"));
    const startTime = String(data.get("startTime") ?? "").trim();
    const endTime = String(data.get("endTime") ?? "").trim();
    const employeeNote = String(data.get("employeeNote"));
    const attachmentFiles = data.getAll("attachments").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (attachmentFiles.length > MAX_ATTACHMENT_COUNT) {
      setFormError(`Choose no more than ${MAX_ATTACHMENT_COUNT} supporting files.`);
      return;
    }
    const unsupportedAttachment = attachmentFiles.find((file) => !ALLOWED_ATTACHMENT_TYPES.has(file.type));
    if (unsupportedAttachment) {
      setFormError(`${unsupportedAttachment.name} is not a supported PDF or image file.`);
      return;
    }
    const oversizedAttachment = attachmentFiles.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversizedAttachment) {
      setFormError(`${oversizedAttachment.name} is larger than 5 MB.`);
      return;
    }
    if (endDate < startDate) {
      setFormError("End date must be on or after the start date.");
      return;
    }
    if (Boolean(startTime) !== Boolean(endTime)) {
      setFormError("Choose both a start time and an end time, or leave both blank for full-day leave.");
      return;
    }
    if ((startTime && !TIME_VALUES.has(startTime)) || (endTime && !TIME_VALUES.has(endTime))) {
      setFormError("Choose start and end times in 15-minute intervals.");
      return;
    }
    let hours: number | undefined;
    if (startTime && endTime) {
      if (!isWeekday(startDate) || !isWeekday(endDate)) {
        setFormError("Timed leave must start and end on weekdays.");
        return;
      }
      if (startDate === endDate && minutesFromTime(endTime) <= minutesFromTime(startTime)) {
        setFormError("End time must be later than start time.");
        return;
      }
      hours = workingHoursBetween(startDate, endDate, startTime, endTime);
      if (hours <= 0) {
        setFormError("Choose a time range that includes working hours.");
        return;
      }
    }
    const days = businessDaysBetween(startDate, endDate);
    if (days < 1) {
      setFormError("Choose at least one weekday for this request.");
      return;
    }
    const nextNumber = requests.reduce((highest, request) => {
      const number = Number(request.id.split("-")[1]);
      return Number.isFinite(number) ? Math.max(highest, number) : highest;
    }, 0) + 1;
    const approvalRequired = activeProfile.accessRole === "employee" && Boolean(activeProfile.manager);
    const attachments = attachmentFiles.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
    }));
    const next: LeaveRequest = {
      id: `SPS-${String(nextNumber).padStart(4, "0")}`,
      employee: activeProfile.name,
      initials: activeProfile.initials,
      team: activeProfile.team,
      leaveType,
      startDate,
      endDate,
      dateLabel: formatDateRange(startDate, endDate),
      days,
      hours,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      approvalRequired,
      status: approvalRequired ? "Pending" : "Approved",
      submittedAt: "Just now",
      manager: activeProfile.manager,
      employeeNote: employeeNote || "No note added.",
      attachments,
    };

    setIsMutating(true);
    setRequests((current) => [next, ...current]);
    setSelectedRequestId(next.id);
    setShowRequestForm(false);
    setFormError("");
    form.reset();
    navigate("leave");
    setIsMutating(false);
    announce(next.approvalRequired
      ? `${next.id} is ready for ${next.manager}'s review in this session.`
      : `${next.id} was added to the calendar. No approval is needed.`);
  }

  async function decideRequest(status: "Approved" | "Declined") {
    if (!selectedRequest || isMutating || isPreviewingEmployeeAccess) return;
    if (status === "Declined" && !managerNote.trim()) {
      announce("Add a manager comment before declining this request.");
      return;
    }
    setIsMutating(true);
    const decidedRequest: LeaveRequest = {
      ...selectedRequest,
      status,
      managerNote: managerNote.trim() || "Coverage checked and confirmed.",
    };

    setRequests((current) => current.map((request) => request.id === selectedRequest.id ? decidedRequest : request));
    const nextApproval = approvalQueue.find((request) => request.id !== selectedRequest.id);
    if (nextApproval) setSelectedRequestId(nextApproval.id);
    setManagerNote("");
    setIsMutating(false);
    announce(`${selectedRequest.id} was ${status.toLowerCase()} in this session.`);
  }

  const navItems = [
    { id: "home" as AppView, label: "Home", icon: LayoutDashboard },
    { id: "leave" as AppView, label: "Leave", icon: ClipboardList, badge: activeProfile.accessRole === "manager" ? approvalQueue.length : undefined },
    { id: "calendar" as AppView, label: "Calendar", icon: CalendarDays },
    { id: "people" as AppView, label: "People", icon: UsersRound },
  ];

  return (
    <div className={styles.shell} data-company={activeProfile.company}>
      <a className={styles.skipLink} href="#main-content">Skip to workspace</a>
      <aside className={styles.sidebar} aria-label="Safer People System navigation">
        <div className={styles.brandRow}><BrandMark /></div>
        <nav className={styles.nav}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button className={`${styles.navItem} ${activeView === item.id ? styles.navItemActive : ""}`} type="button" onClick={() => navigate(item.id)} key={item.id}>
                <Icon size={17} strokeWidth={1.8} /><b>{item.label}</b>{item.badge ? <i>{item.badge}</i> : null}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.mobileBrand}><BrandMark compact /></div>
          <div className={styles.topActions}>
            <span className={styles.demoStatus} data-state={organisationState} role="status"><i />{organisationState === "live" ? "Live directory" : organisationState === "connecting" ? "Connecting" : "Directory issue"}</span>
            {canPreviewEmployeeAccess ? <div className={styles.accessPreview} data-previewing={isPreviewingEmployeeAccess || undefined}>
              <label htmlFor="employee-access-preview"><Eye size={15} aria-hidden="true" /><span>Preview employee access</span></label>
              <select id="employee-access-preview" value={previewProfile?.id ?? ""} onChange={(event) => changeEmployeeAccessPreview(event.target.value)}>
                <option value="">HR workspace</option>
                {directoryProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.roleLabel}</option>)}
              </select>
              {isPreviewingEmployeeAccess ? <button className={styles.exitPreviewButton} type="button" onClick={() => changeEmployeeAccessPreview("")}>Return to HR</button> : null}
            </div> : null}
            {directorySupabase ? <form action={signOut}><button className={styles.signOutButton} type="submit" aria-label="Sign out"><LogOut size={15} /><span className={styles.actionLabel}>Sign out</span></button></form> : null}
          </div>
        </header>

        <main className={styles.main} id="main-content">
          {isPreviewingEmployeeAccess ? <section className={styles.previewNotice} role="status">
            <Eye size={18} aria-hidden="true" />
            <span><strong>Previewing {activeProfile.name}&apos;s employee access</strong><small>This is a read-only interface preview. You remain signed in as {adminProfile.name}; HR tools and private records are hidden.</small></span>
            <button type="button" onClick={() => changeEmployeeAccessPreview("")}>Return to HR view</button>
          </section> : null}
          {activeView !== "people" ? <section className={styles.pageHeader}>
            <div><h1>{viewTitles[activeView].title}</h1>{viewTitles[activeView].helper ? <p>{viewTitles[activeView].helper}</p> : null}</div>
            <button className={styles.primaryButton} type="button" onClick={() => setShowRequestForm(true)} disabled={isMutating || isPreviewingEmployeeAccess}><Plus size={17} /> {activeProfile.accessRole === "employee" ? "New leave request" : "Add leave"}</button>
          </section> : null}

          {activeView === "home" ? <HomeView profile={activeProfile} requests={calendarRequests} myRequests={myRequests} pending={approvalQueue} onNavigate={navigate} onSelect={selectRequest} /> : null}
          {activeView === "leave" ? <LeaveView profile={activeProfile} section={leaveSection} requests={filteredRequests} allRequests={visibleRequests} selected={selectedRequest} filter={statusFilter} pending={approvalQueue} selectedId={selectedRequestId} note={managerNote} calendarRequests={calendarRequests} busy={isMutating} readOnly={isPreviewingEmployeeAccess} hidePrivateDetails={isPreviewingEmployeeAccess} onFilter={setStatusFilter} onSection={chooseLeaveSection} onNote={setManagerNote} onSelect={selectRequest} onDecision={decideRequest} /> : null}
          {activeView === "calendar" ? <CalendarView requests={calendarRequests} /> : null}
          <div hidden={activeView !== "people"}>
            <PeopleOperationsDemo
              key={showHrWorkspace ? "hr-directory" : isPreviewingEmployeeAccess ? `employee-preview:${activeProfile.id}` : "standard-people"}
              activeProfile={activeProfile}
              organisationProfiles={organisationPeople}
              canEditOrganisation={false}
              canArrangeOrganisation={canEditOrganisation && showHrWorkspace}
              isAccessPreview={isPreviewingEmployeeAccess}
              onCreateOrganisationPerson={createOrganisationPerson}
              onUpdateOrganisationPerson={updateOrganisationPerson}
              onOpenEmployeeDirectoryRecord={showHrWorkspace ? setEmployeeDirectorySelectedPersonId : undefined}
              renderEmployeeDirectory={showHrWorkspace ? <EmployeeDirectory
                onRecordsChanged={async () => {
                  await Promise.all([loadOrganisation(), loadAccounts()]);
                }}
                onSelectedPersonId={setEmployeeDirectorySelectedPersonId}
                refreshKey={employeeDirectoryRefreshKey}
                selectedPersonId={employeeDirectorySelectedPersonId}
              /> : undefined}
              renderAccounts={isAdmin && showHrWorkspace ? accountsLoading
                ? <div className={styles.emptyState}><UsersRound size={24} /><strong>Loading accounts</strong></div>
                : accountsError
                ? <div className={styles.emptyState}><ShieldCheck size={24} /><strong>Accounts could not be loaded</strong><span>{accountsError}</span></div>
                : <AccountManagement
                    accounts={accounts}
                    onAccountChanged={updateAccountRecord}
                    onCreateAccount={createPortalAccount}
                    onUpdateLogin={updatePortalLogin}
                    onResetPassword={resetPortalPassword}
                    onToggleEnabled={togglePortalAccount}
                  />
                : undefined}
            />
          </div>
        </main>
      </div>

      {showRequestForm ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowRequestForm(false)}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="new-request-title">
            <header><div><span>{activeProfile.accessRole === "employee" ? "New request" : "New calendar entry"}</span><h2 id="new-request-title">{activeProfile.accessRole === "employee" ? "Request leave" : "Add your leave"}</h2></div><button type="button" onClick={() => setShowRequestForm(false)} aria-label="Close request form"><X size={19} /></button></header>
            <div className={styles.formPerson}><span className={styles.avatarOrange}>{activeProfile.initials}</span><span><strong>{activeProfile.name}</strong><small>{activeProfile.accessRole === "employee" && activeProfile.manager ? `${activeProfile.team} · Approver: ${activeProfile.manager}` : `${activeProfile.team} · Added directly, no approval needed`}</small></span></div>
            <form className={styles.form} onSubmit={submitRequest}>
              <label><span>Leave type</span><select name="leaveType" defaultValue="Annual leave" required><option>Annual leave</option><option>Sick leave</option><option>Carer&apos;s leave</option><option>Unpaid leave</option></select></label>
              <div className={styles.formRow}><label><span>Start date</span><input name="startDate" type="date" defaultValue="2026-09-21" required /></label><label><span>End date</span><input name="endDate" type="date" defaultValue="2026-09-21" required /></label></div>
              <fieldset className={styles.timeRange}><legend>Start and end times <small>Optional</small></legend><div className={styles.formRow}><label><span>From · first day</span><select name="startTime" defaultValue=""><option value="">Select time</option>{START_TIME_OPTIONS.map((option) => <option value={option.value} key={`start-${option.value}`}>{option.label}</option>)}</select></label><label><span>To · last day</span><select name="endTime" defaultValue=""><option value="">Select time</option>{END_TIME_OPTIONS.map((option) => <option value={option.value} key={`end-${option.value}`}>{option.label}</option>)}</select></label></div><p>6:00 am–6:00 pm in 15-minute intervals. For multiple dates, these apply to the first and last day. Leave both blank for full working days.</p></fieldset>
              <label><span>{activeProfile.accessRole === "employee" && activeProfile.manager ? "Note for your manager" : "Private note"} <small>Optional</small></span><textarea name="employeeNote" rows={3} placeholder={activeProfile.accessRole === "employee" && activeProfile.manager ? "Add only what your manager needs to decide." : "Add optional details for your own record."} /></label>
              <label className={styles.attachmentField}><span>Supporting files <small>Optional</small></span><input className={styles.fileInput} name="attachments" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple /><small>PDF or images · up to 3 files, 5 MB each. Files stay in this open session.</small></label>
              <div className={styles.privacyNote}><ShieldCheck size={17} /><span>{activeProfile.accessRole === "employee" && activeProfile.manager ? "Your note is private to you, your approver and HR." : "Your note is private to you and HR."} Coworkers only see that you are unavailable.</span></div>
              {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
              <footer><button className={styles.secondaryButton} type="button" onClick={() => setShowRequestForm(false)} disabled={isMutating}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={isMutating}>{isMutating ? "Saving…" : activeProfile.accessRole === "employee" && activeProfile.manager ? "Send request" : "Add leave"} <ArrowUpRight size={16} /></button></footer>
            </form>
          </section>
        </div>
      ) : null}

      <div className={`${styles.toast} ${toast ? styles.toastVisible : ""}`} role="status" aria-live="polite"><CheckCircle2 size={17} />{toast}</div>
    </div>
  );
}

function DirectoryLoading({ state }: { state: DirectoryState }) {
  return <div className={styles.shell} data-company="mam">
    <aside className={styles.sidebar} aria-label="Safer People System navigation">
      <div className={styles.brandRow}><BrandMark /></div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.topbar} />
      <main className={styles.main} id="main-content">
        <div className={styles.emptyState}>
          <UsersRound size={25} />
          <strong>{state === "error" ? "The directory could not be loaded" : "Loading your profile"}</strong>
          <span>{state === "error" ? "Refresh the page or ask the system administrator to check your account link." : "Connecting to the live organisation directory…"}</span>
        </div>
      </main>
    </div>
  </div>;
}

function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`${styles.status} ${styles[`status${status}`]}`}><i />{status}</span>;
}

function HomeView({ profile, requests, myRequests, pending, onNavigate, onSelect }: { profile: Profile; requests: LeaveRequest[]; myRequests: LeaveRequest[]; pending: LeaveRequest[]; onNavigate: (view: AppView, section?: LeaveSection) => void; onSelect: (id: string, section?: LeaveSection) => void }) {
  const nextOwn = myRequests.find((request) => request.status === "Pending") ?? myRequests[0];
  const attentionRequests = profile.accessRole === "manager" ? pending : requests.filter((request) => request.status === "Pending" && request.employee !== profile.name);
  const attentionTitle = profile.accessRole === "manager" ? "Needs my review" : "Pending leave";
  const recordSection: LeaveSection = profile.accessRole === "manager" ? "approvals" : "requests";

  if (profile.accessRole === "employee") {
    return (
      <div className={styles.dashboard}>
        <section className={`${styles.panel} ${styles.myLeavePanel} ${styles.personalLeavePanel}`}>
          <PanelHeader title="My leave" action="View requests" onAction={() => onNavigate("leave")} />
          {nextOwn ? (
            <button className={styles.nextLeaveSimple} type="button" onClick={() => onSelect(nextOwn.id, "requests")}>
              <span><StatusPill status={nextOwn.status} /><strong>{nextOwn.leaveType}</strong><small>{nextOwn.dateLabel} · {formatDurationWithTime(nextOwn)}</small></span>
              <ChevronRight size={17} />
            </button>
          ) : <div className={styles.emptyState}><CalendarDays size={24} /><strong>No leave requests yet</strong><span>Use “New leave request” when you need time away.</span></div>}
        </section>
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      <div className={styles.homeGrid}>
        <section className={`${styles.panel} ${styles.attentionPanel}`}>
          <PanelHeader title={attentionTitle} action={profile.accessRole === "manager" ? "Open queue" : "View requests"} onAction={() => onNavigate("leave", recordSection)} />
          <div className={styles.recordList}>
            {attentionRequests.slice(0, 3).map((request) => <button type="button" onClick={() => onSelect(request.id, recordSection)} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small></span><span className={styles.dayCount}>{request.hours ?? request.days}<small>{request.hours ? (request.hours === 1 ? "hour" : "hours") : request.days === 1 ? "day" : "days"}</small></span><ChevronRight size={16} /></button>)}
            {!attentionRequests.length ? <div className={styles.emptyState}><CheckCircle2 size={24} /><strong>Nothing needs action</strong></div> : null}
          </div>
        </section>

        <section className={`${styles.panel} ${styles.myLeavePanel}`}>
          <PanelHeader title="My leave" action="View requests" onAction={() => onNavigate("leave")} />
          {nextOwn ? <button className={styles.nextLeaveSimple} type="button" onClick={() => onSelect(nextOwn.id, "requests")}><span><StatusPill status={nextOwn.status} /><strong>{nextOwn.leaveType}</strong><small>{nextOwn.dateLabel} · {formatDurationWithTime(nextOwn)}</small></span><ChevronRight size={17} /></button> : <div className={styles.emptyState}><CalendarDays size={24} /><strong>No leave requests yet</strong></div>}
        </section>
      </div>
    </div>
  );
}

function PanelHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <header className={styles.panelHeader}><h2>{title}</h2>{action && onAction ? <button type="button" onClick={onAction}>{action}<ChevronRight size={14} /></button> : null}</header>;
}

function LeaveView({ profile, section, requests, allRequests, selected, filter, pending, selectedId, note, calendarRequests, busy, readOnly, hidePrivateDetails, onFilter, onSection, onNote, onSelect, onDecision }: { profile: Profile; section: LeaveSection; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected?: LeaveRequest; filter: "All" | RequestStatus; pending: LeaveRequest[]; selectedId: string; note: string; calendarRequests: LeaveRequest[]; busy: boolean; readOnly: boolean; hidePrivateDetails: boolean; onFilter: (filter: "All" | RequestStatus) => void; onSection: (section: LeaveSection) => void; onNote: (note: string) => void; onSelect: (id: string, section?: LeaveSection) => void; onDecision: (status: "Approved" | "Declined") => void }) {
  const canApprove = profile.accessRole === "manager";
  return (
    <section className={styles.leaveDesk}>
      {canApprove ? (
        <div className={styles.leaveSwitch} aria-label="Leave workspace">
          <button className={section === "requests" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "requests"} onClick={() => onSection("requests")}>
            <strong>Leave register</strong><i>{allRequests.length}</i>
          </button>
          <button className={section === "approvals" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "approvals"} onClick={() => onSection("approvals")}>
            <strong>Needs my review</strong><i>{pending.length}</i>
          </button>
        </div>
      ) : null}
      {section === "requests" ? <RequestsView profile={profile} requests={requests} allRequests={allRequests} selected={selected} filter={filter} hidePrivateDetails={hidePrivateDetails} onFilter={onFilter} onSelect={(id) => onSelect(id, "requests")} /> : null}
      {section === "approvals" && canApprove ? <ApprovalsView pending={pending} selected={selected} selectedId={selectedId} note={note} requests={calendarRequests} busy={busy} readOnly={readOnly} hidePrivateDetails={hidePrivateDetails} onNote={onNote} onSelect={(id) => onSelect(id, "approvals")} onDecision={onDecision} /> : null}
    </section>
  );
}

function RequestsView({ profile, requests, allRequests, selected, filter, hidePrivateDetails, onFilter, onSelect }: { profile: Profile; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected?: LeaveRequest; filter: "All" | RequestStatus; hidePrivateDetails: boolean; onFilter: (filter: "All" | RequestStatus) => void; onSelect: (id: string) => void }) {
  const filters: ("All" | RequestStatus)[] = ["All", "Pending", "Approved", "Declined"];
  const isEmployee = profile.accessRole === "employee";
  return (
    <section className={styles.recordsWorkspace}>
      <div className={styles.viewToolbar}>
        <div className={styles.filterTabs}>{filters.map((item) => <button className={filter === item ? styles.filterActive : ""} type="button" onClick={() => onFilter(item)} key={item}>{item}<span>{item === "All" ? allRequests.length : allRequests.filter((request) => request.status === item).length}</span></button>)}</div>
      </div>
      <div className={`${styles.recordsGrid} ${isEmployee ? styles.employeeRecordsGrid : ""} ${!selected ? styles.recordsGridNoDetail : ""}`}>
        <div className={styles.recordsTable} role="table" aria-label="Leave requests">
          <div className={`${styles.tableHead} ${isEmployee ? styles.employeeTableRow : ""}`} role="row">{!isEmployee ? <span>Employee</span> : null}<span>Leave</span><span>Dates</span><span>Duration</span><span>Status</span><span /></div>
          {requests.map((request) => <button className={`${styles.tableRow} ${isEmployee ? styles.employeeTableRow : ""} ${selected?.id === request.id ? styles.tableRowActive : ""}`} type="button" onClick={() => onSelect(request.id)} role="row" key={request.id}>{!isEmployee ? <span><i>{request.initials}</i><b>{request.employee === profile.name ? "You" : request.employee}<small>{request.team}</small></b></span> : null}<span><b>{request.leaveType}</b><small>{request.id}</small></span><span>{request.dateLabel}</span><span>{formatDuration(request)}{formatTimeRange(request) ? <small>{formatTimeRange(request)}</small> : null}</span><span><StatusPill status={request.status} /></span><ChevronRight size={15} /></button>)}
          {!requests.length ? <div className={styles.emptyState}><Search size={23} /><strong>{allRequests.length ? "No requests match this status" : "No leave requests yet"}</strong><span>{allRequests.length ? "Choose another status." : isEmployee ? "Use “New leave request” when you need time away." : "Leave added in this session will appear here."}</span></div> : null}
        </div>
        {selected ? <RequestDetail profile={profile} request={selected} hidePrivateDetails={hidePrivateDetails} /> : null}
      </div>
    </section>
  );
}

function RequestDetail({ profile, request, hidePrivateDetails }: { profile: Profile; request: LeaveRequest; hidePrivateDetails: boolean }) {
  const canViewAttachments = !hidePrivateDetails && (profile.accessRole === "manager" || profile.accessRole === "hr");
  const showEmployee = profile.accessRole !== "employee" && request.employee !== profile.name;
  return <aside className={styles.detailPanel} aria-label={`${request.id} details`}><header className={!showEmployee ? styles.personalDetailHeader : undefined}>{showEmployee ? <span className={styles.avatarOrange}>{request.initials}</span> : null}<span><small>{request.id}</small>{showEmployee ? <><h2>{request.employee}</h2><p>{request.team}</p></> : <h2>{request.leaveType}</h2>}</span></header><StatusPill status={request.status} /><dl>{showEmployee ? <div><dt>Leave type</dt><dd>{request.leaveType}</dd></div> : null}<div><dt>When</dt><dd>{request.dateLabel}</dd></div><div><dt>Duration</dt><dd>{formatDurationWithTime(request)}</dd></div><div><dt>Approval</dt><dd>{request.approvalRequired ? request.manager : "Not required"}</dd></div></dl>{!hidePrivateDetails && request.employeeNote !== "No note added." ? <section><span>{request.approvalRequired ? "Employee note" : "Private note"}</span><p>{request.employeeNote}</p><small><ShieldCheck size={13} /> {request.approvalRequired ? "Private to employee, approver and HR" : "Private to this person and HR"}</small></section> : null}{canViewAttachments ? <AttachmentList attachments={request.attachments} /> : null}{!hidePrivateDetails && request.managerNote ? <section><span>Manager decision note</span><p>{request.managerNote}</p></section> : null}</aside>;
}

function AttachmentList({ attachments }: { attachments?: LeaveAttachment[] }) {
  if (!attachments?.length) return null;
  return <section className={styles.attachmentList}><span><Paperclip size={14} /> Supporting files · private</span>{attachments.map((attachment) => { const Icon = attachment.mimeType === "application/pdf" ? FileText : FileImage; return <a href={attachment.previewUrl} target="_blank" rel="noreferrer" key={attachment.id}><Icon size={17} /><span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.sizeBytes)}</small></span><Eye size={15} /></a>; })}<small><ShieldCheck size={13} /> Only managers and HR can open these files.</small></section>;
}

function ApprovalsView({ pending, selected, selectedId, note, requests, busy, readOnly, hidePrivateDetails, onNote, onSelect, onDecision }: { pending: LeaveRequest[]; selected?: LeaveRequest; selectedId: string; note: string; requests: LeaveRequest[]; busy: boolean; readOnly: boolean; hidePrivateDetails: boolean; onNote: (note: string) => void; onSelect: (id: string) => void; onDecision: (status: "Approved" | "Declined") => void }) {
  const showQueue = pending.length > 1 || !selected;
  return <div className={`${styles.approvalGrid} ${!selected ? styles.approvalGridEmpty : ""} ${!showQueue ? styles.approvalGridSingle : ""}`}>
    {showQueue ? <section className={`${styles.panel} ${styles.queue}`}><PanelHeader title="Requests" />{pending.length ? pending.map((request) => <button className={selectedId === request.id ? styles.queueActive : ""} type="button" onClick={() => onSelect(request.id)} disabled={busy} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small></span><ChevronRight size={16} /></button>) : <div className={styles.emptyState}><CheckCircle2 size={25} /><strong>Nothing needs review</strong></div>}</section> : null}
    {selected ? <section className={`${styles.panel} ${styles.approvalRecord}`}>
      <header className={styles.approvalHeader}><span className={styles.avatarOrange}>{selected.initials}</span><span><small>{selected.id}</small><h2>{selected.employee}</h2><p>{selected.team}</p></span><StatusPill status={selected.status} /></header>
      <div className={styles.factGrid}><article><CalendarDays size={17} /><span><small>When</small><strong>{selected.dateLabel}</strong></span></article><article><Clock3 size={17} /><span><small>Duration</small><strong>{formatDurationWithTime(selected)}</strong></span></article><article><ClipboardList size={17} /><span><small>Leave type</small><strong>{selected.leaveType}</strong></span></article></div>
      {!hidePrivateDetails && <div className={styles.privateNote}><span><ShieldCheck size={14} /> Employee note · private</span><p>{selected.employeeNote}</p></div>}
      {!hidePrivateDetails && <AttachmentList attachments={selected.attachments} />}
      <ApprovalCalendar selected={selected} requests={requests} />
      {selected.status === "Pending" ? <div className={styles.decisionBox}><label><span>Decision note <small>Required when declining</small></span><textarea rows={3} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Add context that will remain with this record." disabled={busy || readOnly} /></label><div><button className={styles.declineButton} type="button" onClick={() => onDecision("Declined")} disabled={busy || readOnly}><XCircle size={16} /> {busy ? "Sending…" : readOnly ? "Preview only" : "Decline"}</button><button className={styles.approveButton} type="button" onClick={() => onDecision("Approved")} disabled={busy || readOnly}><CheckCircle2 size={16} /> {busy ? "Sending…" : readOnly ? "Preview only" : "Approve leave"}</button></div></div> : <div className={styles.decisionRecorded}><CheckCircle2 size={19} /><span><strong>Decision recorded</strong><small>The employee view and leave register show {selected.status.toLowerCase()}.</small></span></div>}
    </section> : null}
  </div>;
}

function ApprovalCalendar({ selected, requests }: { selected: LeaveRequest; requests: LeaveRequest[] }) {
  const days = getApprovalCalendarDays(selected);
  const rangeStart = days[0].iso;
  const rangeEnd = days[days.length - 1].iso;
  const teamLeave = requests.filter((request) => request.id !== selected.id && request.employee !== selected.employee && request.team === selected.team && request.status !== "Declined" && request.endDate >= rangeStart && request.startDate <= rangeEnd);
  const overlaps = teamLeave.filter((request) => requestsOverlap(selected, request));

  return (
    <section className={styles.calendarImpact} aria-labelledby="calendar-impact-title">
      <header className={styles.impactHeader}>
        <div><h3 id="calendar-impact-title">Coverage calendar</h3><p>Three weeks before and after this request · {formatDateRange(rangeStart, rangeEnd)}</p></div>
        <span className={overlaps.length ? styles.impactWarning : styles.impactClear}>{overlaps.length ? `${overlaps.length} ${overlaps.length === 1 ? "overlap" : "overlaps"}` : "No direct overlap"}</span>
      </header>
      <div className={styles.impactLegend} aria-label="Calendar legend">
        <span><i className={styles.legendApplicant} />This request</span>
        <span><i className={styles.legendApproved} />Approved leave</span>
        <span><i className={styles.legendPending} />Pending leave</span>
      </div>
      <div className={styles.reviewCalendarViewport} tabIndex={0} aria-label="Scrollable coverage calendar">
        <div className={styles.reviewCalendar} role="grid" aria-label={`Team leave from ${formatDateRange(rangeStart, rangeEnd)}`}>
          <div className={styles.reviewCalendarWeek} role="row">
            {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((weekday) => <span role="columnheader" key={weekday}>{weekday}</span>)}
          </div>
          <div className={styles.reviewCalendarGrid}>
            {days.map((day, index) => {
              const isRequestedDay = day.iso >= selected.startDate && day.iso <= selected.endDate;
              const otherLeave = teamLeave.filter((request) => day.iso >= request.startDate && day.iso <= request.endDate);
              return (
                <div className={`${styles.reviewCalendarDay} ${day.isWeekend ? styles.reviewCalendarWeekend : ""} ${isRequestedDay ? styles.reviewCalendarRequestedDay : ""}`} role="gridcell" key={day.iso}>
                  <time dateTime={day.iso}><b>{day.day}</b>{day.day === 1 || index === 0 ? <span>{day.month}</span> : null}</time>
                  {isRequestedDay ? <article className={styles.reviewEventApplicant}><i>{selected.initials}</i><span><strong>{selected.employee}</strong><small>{formatTimeRange(selected) || "This request"}</small></span></article> : null}
                  {otherLeave.slice(0, 2).map((request) => <article className={request.status === "Approved" ? styles.reviewEventApproved : styles.reviewEventPending} key={request.id}><i>{request.initials}</i><span><strong>{request.employee}</strong><small>{formatTimeRange(request) || `${request.status} leave`}</small></span></article>)}
                  {otherLeave.length > 2 ? <span className={styles.reviewMoreLeave}>+{otherLeave.length - 2} more</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className={styles.reviewCalendarPrivacy}><ShieldCheck size={14} /> Team dates and status only. Private reasons stay hidden.</p>
    </section>
  );
}

function CalendarView({ requests }: { requests: LeaveRequest[] }) {
  const days = getCalendarDays();
  const visible = requests.filter((request) => request.status !== "Declined");
  return <section className={`${styles.panel} ${styles.calendarPanel}`}><div className={styles.calendarToolbar}><strong>August 2026</strong><div className={styles.legend}><span><i className={styles.legendApproved} />Approved</span><span><i className={styles.legendPending} />Pending</span></div></div><div className={styles.calendarWeek}>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}</div><div className={styles.calendarGrid}>{days.map((day) => { const events = visible.filter((request) => day.iso >= request.startDate && day.iso <= request.endDate); return <div className={`${styles.calendarDay} ${day.inMonth ? "" : styles.calendarMuted}`} key={day.iso}><span>{day.day}</span>{events.slice(0, 3).map((request) => <article className={request.status === "Approved" ? styles.eventApproved : styles.eventPending} key={request.id}><i>{request.initials}</i><b>{request.employee}<small>{request.status} leave</small></b></article>)}{events.length > 3 ? <small className={styles.calendarMore}>+{events.length - 3} more</small> : null}</div>; })}</div><footer className={styles.calendarPrivacy}><ShieldCheck size={15} /> Private notes are never shown here.</footer></section>;
}
