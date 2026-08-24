"use client";

import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ClipboardList,
  Clock3,
  Eye,
  FileText,
  LayoutDashboard,
  Plus,
  Paperclip,
  RotateCcw,
  Search,
  ShieldCheck,
  LogOut,
  Upload,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import {
  getCurrentEmployeeSelfProfile,
  getSelectedEmployeeProfile,
  updateCurrentEmployeeSelfProfile,
  updateSelectedEmployeeProfile,
  type CurrentEmployeeSelfProfile,
  type SelectedEmployeeProfile,
} from "@/app/profile/actions";
import {
  createPortalAccount,
  listPortalAccounts,
  resetPortalPassword,
  togglePortalAccount,
  updatePortalLogin,
} from "@/app/accounts/actions";
import {
  cancelMyApprovedLeaveRequest,
  completeLeaveRequestAttachmentUpload,
  decideLeaveRequest,
  discardLeaveRequestAttachmentUpload,
  getLeaveWorkspaceData,
  prepareLeaveRequestAttachmentUpload,
  submitLeaveRequest,
  submitLeaveRequestForSelectedEmployee,
  type BirthdayCalendarEntry,
  type CheckInCalendarEntry,
  type LeaveAttachment,
  type LeaveCalendarEntry,
  type LeaveWorkspaceRequest,
} from "@/app/leave/actions";
import { signOut } from "@/app/login/actions";
import {
  AccountManagement,
  type AccountDto,
} from "@/components/account-management";
import { CheckInRegister } from "@/components/check-in-register";
import { CheckInWorkspace } from "@/components/check-in-workspace";
import { CheckInTasks } from "@/components/check-in-tasks";
import { EmployeeDirectory } from "@/components/employee-directory";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  SelfProfileMenu,
  type SelfProfileChanges,
  type SelfProfileData,
} from "@/components/self-profile-menu";
import styles from "@/components/leave-demo.module.css";
import { PeopleOperationsDemo } from "@/components/people-operations-demo";
import type {
  OrganisationCompany,
  OrganisationPerson,
  OrganisationPersonDraft,
} from "@/components/organisation-tree";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { CheckInResourceLinks } from "@/lib/check-in-register-types";

type AppView = "home" | "leave" | "calendar" | "people";
type LeaveSection = "requests" | "approvals";
type RequestStatus = "Pending" | "Approved" | "Declined" | "Cancelled";
type AccessRole = "hr" | "manager" | "employee";
type PreviewAccessRole = Exclude<AccessRole, "hr">;

type LeaveRequest = {
  id: string;
  personId?: string;
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
  assignedReviewerLabel?: string;
  canDecide: boolean;
  /** Server-derived only. A missing capability intentionally fails closed. */
  canCancel: boolean;
  /** Server-derived only. Missing support fails closed. */
  canAttach: boolean;
  employeeNote?: string;
  managerNote?: string;
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

// The current HR reference charts (PDF and SVG) contain people and reporting
// lines only. These legacy placeholder org-unit cards are not present in
// either reference, so keep them out of the chart without deleting the
// underlying records. Their children are reattached to the nearest real
// person below when the chart DTO is built.
const legacyReferenceOrgUnitLabels = new Set([
  "scheduling team",
  "estimating team",
  "trades team",
  "admin team",
  "cso team",
]);

function isLegacyReferenceOrgUnit(row: InternalOrgRow) {
  return row.node_kind === "org_unit"
    && legacyReferenceOrgUnitLabels.has(row.position_title.trim().toLocaleLowerCase());
}

type DirectoryState = "connecting" | "live" | "error";

type InitialNavigation = {
  view: AppView;
  section: LeaveSection;
  requestId?: string;
};

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
const MAX_LEAVE_ATTACHMENTS = 10;
const MAX_LEAVE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const LEAVE_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const LEAVE_ATTACHMENT_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif";

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cancelLeaveTriggerId(requestId: string) {
  return `cancel-leave-${requestId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function validateLeaveAttachmentFiles(files: File[], existingCount = 0) {
  if (files.length + existingCount > MAX_LEAVE_ATTACHMENTS) {
    return `A leave request can have up to ${MAX_LEAVE_ATTACHMENTS} supporting files.`;
  }
  const unsupported = files.find((file) => !LEAVE_ATTACHMENT_MIME_TYPES.has(file.type.toLowerCase()));
  if (unsupported) return `${unsupported.name || "That file"} is not a supported PDF or image file.`;
  const empty = files.find((file) => file.size < 1);
  if (empty) return `${empty.name || "That file"} is empty.`;
  const oversized = files.find((file) => file.size > MAX_LEAVE_ATTACHMENT_BYTES);
  if (oversized) return `${oversized.name || "That file"} is larger than 5 MB.`;
  const unsafeName = files.find((file) => !file.name.trim() || file.name.length > 255 || /[\\/\u0000-\u001f]/u.test(file.name));
  if (unsafeName) return "One supporting file has an unsupported name. Rename it and try again.";
  return "";
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

function nextAvailableLeaveDate() {
  const date = new Date();
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return toIsoDate(date);
}

function scrollPageToTop() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
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

function startOfCalendarMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function getCalendarMonthLabel(month: Date) {
  return new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric" }).format(month);
}

function getCalendarDays(month: Date) {
  const first = startOfCalendarMonth(month);
  const firstWeekday = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - firstWeekday);
  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(first);
    current.setDate(first.getDate() + index);
    return {
      iso: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`,
      day: current.getDate(),
      inMonth: current.getMonth() === month.getMonth() && current.getFullYear() === month.getFullYear(),
    };
  });
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function birthdayOccursOnCalendarDate(birthday: BirthdayCalendarEntry, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  if (birthday.month !== month) return false;
  if (birthday.day === day) return true;

  // A recurring 29 February birthday remains visible every year. The system
  // observes it on 28 February where the selected calendar year has no 29th.
  return birthday.month === 2
    && birthday.day === 29
    && day === 28
    && !isLeapYear(year);
}

function checkInMilestoneLabel(milestone: CheckInCalendarEntry["milestone"]) {
  if (milestone === "2_week") return "2-week check-in";
  if (milestone === "1_month") return "1-month check-in";
  if (milestone === "3_month") return "3-month check-in";
  return "5-month check-in";
}

function getViewTitles(profile: Profile, calendarMonth: Date, canReviewLeave: boolean): Record<Exclude<AppView, "people">, { title: string; helper?: string }> {
  return {
    home: { title: "Home" },
    leave: { title: canReviewLeave ? "Leave" : "My leave" },
    calendar: { title: "Team calendar", helper: getCalendarMonthLabel(calendarMonth) },
  };
}

function getEmployeePreviewRequests(requests: LeaveRequest[], profile: Profile) {
  // Change profile scopes the view to the selected employee for the Super
  // Admin, while all reviewer/capability decisions still come from the
  // signed-in account's server-projected request fields.
  return requests.filter((request) => request.personId === profile.id);
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

function toLeaveRequest(record: LeaveWorkspaceRequest): LeaveRequest {
  return {
    id: record.id,
    personId: record.personId,
    employee: record.employee,
    initials: initialsForName(record.employee),
    team: record.company === "mam" ? "MAM" : "Equipsy",
    leaveType: record.leaveType,
    startDate: record.startDate,
    endDate: record.endDate,
    dateLabel: formatDateRange(record.startDate, record.endDate),
    days: record.days,
    hours: record.hours,
    startTime: record.startTime,
    endTime: record.endTime,
    approvalRequired: record.approvalRequired,
    status: record.status,
    submittedAt: record.submittedAt,
    assignedReviewerLabel: record.assignedReviewerLabel,
    canDecide: record.canDecide,
    canCancel: record.canCancel === true,
    canAttach: record.canAttach === true,
    employeeNote: record.employeeNote,
    managerNote: record.managerNote,
  };
}

function toCalendarLeaveRequest(record: LeaveCalendarEntry): LeaveRequest {
  return {
    id: record.id,
    personId: record.personId,
    employee: record.employee,
    initials: initialsForName(record.employee),
    team: record.company === "mam" ? "MAM" : "Equipsy",
    leaveType: record.leaveType,
    startDate: record.startDate,
    endDate: record.endDate,
    dateLabel: formatDateRange(record.startDate, record.endDate),
    days: record.days,
    hours: record.hours,
    startTime: record.startTime,
    endTime: record.endTime,
    approvalRequired: true,
    status: record.status,
    submittedAt: "",
    canDecide: false,
    canCancel: false,
    canAttach: false,
  };
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
  isNonRosterSystemAdmin = false,
  canViewCheckIns = false,
  canChangeEmployeeView = false,
  canViewCheckInTasks = false,
  checkInResources,
}: {
  initialNavigation?: InitialNavigation;
  isAdmin?: boolean;
  currentPersonId?: string;
  /**
   * A narrowly authorised platform administrator may operate HR tools without
   * becoming a synthetic employee in the authoritative roster. It has no
   * self-service profile or own-leave workspace.
   */
  isNonRosterSystemAdmin?: boolean;
  /** Server-issued capability; row scope is independently enforced by each RPC. */
  canViewCheckIns?: boolean;
  canChangeEmployeeView?: boolean;
  canViewCheckInTasks?: boolean;
  checkInResources?: CheckInResourceLinks;
}) {
  const directorySupabase = isSupabaseConfigured() ? createClient() : null;
  const isNonRosterSystemAdminWorkspace = isNonRosterSystemAdmin && !currentPersonId;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [activeView, setActiveView] = useState<AppView>(initialNavigation?.view ?? "home");
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [leaveAttachments, setLeaveAttachments] = useState<LeaveAttachment[]>([]);
  const [calendarEntries, setCalendarEntries] = useState<LeaveRequest[]>([]);
  const [calendarBirthdays, setCalendarBirthdays] = useState<BirthdayCalendarEntry[]>([]);
  const [checkInCalendarEntries, setCheckInCalendarEntries] = useState<CheckInCalendarEntry[]>([]);
  const [canReviewLeaveWorkspace, setCanReviewLeaveWorkspace] = useState(false);
  const [leaveDataLoading, setLeaveDataLoading] = useState(true);
  const [leaveDataError, setLeaveDataError] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() => startOfCalendarMonth(new Date()));
  const [selectedRequestId, setSelectedRequestId] = useState(initialNavigation?.requestId ?? "");
  const [leaveSection, setLeaveSection] = useState<LeaveSection>(initialNavigation?.section ?? "requests");
  const [statusFilter, setStatusFilter] = useState<"All" | RequestStatus>("All");
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [managerNote, setManagerNote] = useState("");
  const [formError, setFormError] = useState("");
  const [cancellationRequestId, setCancellationRequestId] = useState<string | null>(null);
  const [cancellationFocusRequestId, setCancellationFocusRequestId] = useState<string | null>(null);
  const [cancellationError, setCancellationError] = useState("");
  const [cancelledRequestId, setCancelledRequestId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [isMutating, setIsMutating] = useState(false);
  const [organisationRows, setOrganisationRows] = useState<InternalOrgRow[]>([]);
  const [canEditOrganisation, setCanEditOrganisation] = useState(false);
  const [canManageEmployeeDirectory, setCanManageEmployeeDirectory] = useState(false);
  const [employeeDirectoryRefreshKey, setEmployeeDirectoryRefreshKey] = useState(0);
  const [employeeDirectorySelectedPersonId, setEmployeeDirectorySelectedPersonId] = useState<string | null>(null);
  const [organisationState, setOrganisationState] = useState<DirectoryState>("connecting");
  const [organisationAccessError, setOrganisationAccessError] = useState("");
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [accountsError, setAccountsError] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selfProfile, setSelfProfile] = useState<CurrentEmployeeSelfProfile | null>(null);
  const [selfProfileLoading, setSelfProfileLoading] = useState(Boolean(currentPersonId));
  const [selfProfileError, setSelfProfileError] = useState("");
  // Private selected-employee details are never derived from the organisation
  // tree. This state is populated only by the HR-authorised server action.
  const [selectedEmployeeProfile, setSelectedEmployeeProfile] = useState<SelectedEmployeeProfile | null>(null);
  const [selectedEmployeeProfileErrorState, setSelectedEmployeeProfileErrorState] = useState<{
    personId: string;
    message: string;
  } | null>(null);
  const [selectedEmployeeProfileReloadKey, setSelectedEmployeeProfileReloadKey] = useState(0);
  // This is intentionally UI-only. It never changes the authenticated user or
  // the capability checks that protect HR records and organisation writes.
  const [previewPersonId, setPreviewPersonId] = useState("");
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [profilePickerQuery, setProfilePickerQuery] = useState("");
  const leaveRefreshSequence = useRef(0);
  const profilePickerDialogRef = useRef<HTMLElement>(null);
  const profilePickerSearchRef = useRef<HTMLInputElement>(null);
  const leaveRequestDialogRef = useRef<HTMLElement>(null);
  const leaveRequestInitialFocusRef = useRef<HTMLSelectElement>(null);
  const closeProfilePicker = useCallback(() => setProfilePickerOpen(false), []);
  const closeLeaveRequestForm = useCallback(() => setShowRequestForm(false), []);

  useDialogFocus(
    profilePickerOpen,
    profilePickerDialogRef,
    profilePickerSearchRef,
    closeProfilePicker,
  );
  useDialogFocus(
    showRequestForm,
    leaveRequestDialogRef,
    leaveRequestInitialFocusRef,
    closeLeaveRequestForm,
  );

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;

    setIsSigningOut(true);
    try {
      await Promise.allSettled([
        signOut(),
        directorySupabase?.auth.signOut({ scope: "local" }) ?? Promise.resolve(),
      ]);
    } finally {
      // Use a document navigation instead of relying on the current React tree
      // to render the Server Action redirect. This guarantees a fresh unauthenticated
      // request after the Supabase cookies have been cleared.
      window.setTimeout(() => window.location.replace("/login"), 150);
    }
  }, [directorySupabase, isSigningOut]);

  const refreshLeaveWorkspace = useCallback(async () => {
    const requestSequence = leaveRefreshSequence.current + 1;
    leaveRefreshSequence.current = requestSequence;
    setLeaveDataLoading(true);
    try {
      const data = await getLeaveWorkspaceData();
      // A save, a safe Realtime invalidation and an initial load can overlap.
      // Only the newest role-scoped response may update calendar data.
      if (requestSequence !== leaveRefreshSequence.current) return;
      setRequests(data.requests.map(toLeaveRequest));
      setLeaveAttachments(data.attachments);
      setCalendarEntries(data.calendarEntries.map(toCalendarLeaveRequest));
      setCalendarBirthdays(data.birthdayEntries);
      setCheckInCalendarEntries(data.checkInEntries);
      setCanReviewLeaveWorkspace(data.canReviewLeave);
      setLeaveDataError(data.warning ?? "");
    } catch {
      if (requestSequence !== leaveRefreshSequence.current) return;
      // Do not leave a previously authorised calendar visible after a session,
      // access, or projection failure. The next successful role-scoped load
      // repopulates it.
      setRequests([]);
      setLeaveAttachments([]);
      setCalendarEntries([]);
      setCalendarBirthdays([]);
      setCheckInCalendarEntries([]);
      setSelectedRequestId("");
      setCancellationRequestId(null);
      setCancellationFocusRequestId(null);
      setCancellationError("");
      setCanReviewLeaveWorkspace(false);
      setLeaveDataError("Leave records could not be loaded. Refresh and try again.");
    } finally {
      if (requestSequence === leaveRefreshSequence.current) setLeaveDataLoading(false);
    }
  }, []);

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
    const [
      { data: rows, error },
      { data: canEdit, error: canEditError },
      { data: canManageEmployeeDirectory, error: canManageEmployeeDirectoryError },
    ] = await Promise.all([
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
      setOrganisationAccessError("");
      return;
    }
    setOrganisationRows((rows ?? []) as InternalOrgRow[]);
    setCanEditOrganisation(canEdit === true);
    setCanManageEmployeeDirectory(canManageEmployeeDirectory === true);
    setOrganisationAccessError(canEditError || canManageEmployeeDirectoryError
      ? "Some People permissions could not be loaded. Retry before making changes."
      : "");
    setOrganisationState("live");
  }, [directorySupabase]);

  const loadSelfProfile = useCallback(async () => {
    if (!currentPersonId) {
      setSelfProfile(null);
      setSelfProfileLoading(false);
      setSelfProfileError("");
      return;
    }

    setSelfProfileLoading(true);
    try {
      setSelfProfile(await getCurrentEmployeeSelfProfile());
      setSelfProfileError("");
    } catch (error) {
      // Do not substitute organisation-tree fields for the private profile
      // DTO. A failed self-only lookup must not accidentally display or save
      // another person's contact data.
      setSelfProfile(null);
      setSelfProfileError(error instanceof Error
        ? error.message
        : "Your profile could not be loaded. Retry before editing it.");
    } finally {
      setSelfProfileLoading(false);
    }
  }, [currentPersonId]);

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
          // HR contact edits deliberately touch only the person's safe public
          // org row. Refresh the authenticated person's self-only DTO too so
          // their top-right card stays current without publishing any private
          // fields through Realtime.
          void loadSelfProfile();
          // Date-of-birth updates also touch this safe public organisation row.
          // Treat that event only as an invalidation signal: the calendar
          // re-reads its narrow birthday DTO and never receives private values
          // from the Realtime payload.
          void refreshLeaveWorkspace();
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
  }, [directorySupabase, loadOrganisation, loadSelfProfile, refreshLeaveWorkspace]);

  useEffect(() => {
    if (!isAdmin || !canManageEmployeeDirectory) return;
    const timer = window.setTimeout(() => void loadAccounts(), 0);
    return () => window.clearTimeout(timer);
  }, [canManageEmployeeDirectory, isAdmin, loadAccounts]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSelfProfile(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSelfProfile]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshLeaveWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshLeaveWorkspace]);

  useEffect(() => {
    if (!directorySupabase) return;
    let refreshTimer: number | undefined;
    const channel = directorySupabase
      .channel("internal:leave-refresh")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "leave_requests",
        },
        () => {
          // Never use a Realtime payload as UI data: it may contain private
          // leave notes. Treat the event only as a signal to reload the
          // role-scoped server DTOs.
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void refreshLeaveWorkspace(), 160);
        },
      )
      .subscribe();

    return () => {
      window.clearTimeout(refreshTimer);
      void directorySupabase.removeChannel(channel);
    };
  }, [directorySupabase, refreshLeaveWorkspace]);

  const organisationPeople = useMemo<OrganisationPerson[]>(() => {
    const rowsById = new Map(organisationRows.map((row) => [row.id, row]));
    const visibleRows = organisationRows.filter(
      (row) => row.node_kind !== "vacancy" && !isLegacyReferenceOrgUnit(row),
    );
    const visibleIds = new Set(visibleRows.map((row) => row.id));
    const nearestVisibleParentId = (row: InternalOrgRow) => {
      const seen = new Set<string>();
      let parentId = row.parent_id;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        if (visibleIds.has(parentId)) return parentId;
        parentId = rowsById.get(parentId)?.parent_id ?? null;
      }
      return null;
    };

    return visibleRows.map((row) => ({
      id: row.id,
      name: row.node_kind === "org_unit" ? row.position_title : row.full_name ?? "Unnamed person",
      position: row.node_kind === "org_unit" ? "" : row.position_title,
      company: row.company_key,
      reportsTo: nearestVisibleParentId(row),
      kind: row.node_kind === "org_unit" ? "org_unit" : "person",
      sortOrder: row.sort_order,
      isActive: row.is_active,
    }));
  }, [organisationRows]);
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
  const canPreviewEmployeeAccess = canChangeEmployeeView && canManageEmployeeDirectory;
  const selectedPreviewCandidate = canPreviewEmployeeAccess && previewPersonId
    ? directoryProfiles.find((profile) => profile.id === previewPersonId)
    : undefined;
  const selectedPreviewPersonId = selectedPreviewCandidate?.id ?? "";
  const selectedEmployeeProfileError = selectedEmployeeProfileErrorState?.personId === selectedPreviewPersonId
    ? selectedEmployeeProfileErrorState.message
    : "";
  const profilePickerResults = useMemo(() => {
    const search = profilePickerQuery.trim().toLocaleLowerCase();
    const candidates = search
      ? directoryProfiles.filter((profile) => [profile.name, profile.roleLabel, profile.team, profile.manager].join(" ").toLocaleLowerCase().includes(search))
      : directoryProfiles;
    return candidates.slice(0, 80);
  }, [directoryProfiles, profilePickerQuery]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedPreviewPersonId) return;

    void getSelectedEmployeeProfile(selectedPreviewPersonId)
      .then((profile) => {
        if (!cancelled && profile.personId === selectedPreviewPersonId) {
          setSelectedEmployeeProfile(profile);
          setSelectedEmployeeProfileErrorState(null);
        }
      })
      .catch((error) => {
        // The org-tree fallback below has no private contact fields and stays
        // disabled. The server action independently re-checks HR authority.
        if (!cancelled) {
          setSelectedEmployeeProfileErrorState({
            personId: selectedPreviewPersonId,
            message: error instanceof Error
              ? error.message
              : "This employee profile could not be loaded. Retry before editing it.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [employeeDirectoryRefreshKey, selectedEmployeeProfileReloadKey, selectedPreviewPersonId]);

  useEffect(() => {
    if (!cancellationRequestId || isMutating) return;

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const requestId = cancellationRequestId;
      setCancellationRequestId(null);
      setCancellationFocusRequestId(requestId);
      setCancellationError("");
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [cancellationRequestId, isMutating]);

  useLayoutEffect(() => {
    if (!cancellationFocusRequestId || cancellationRequestId) return;
    const trigger = document.getElementById(cancelLeaveTriggerId(cancellationFocusRequestId));
    if (!(trigger instanceof HTMLButtonElement)) return;
    trigger.focus({ preventScroll: true });
  }, [cancellationFocusRequestId, cancellationRequestId]);

  const signedInProfile = directoryProfiles.find((profile) => profile.id === currentPersonId)
    ?? (isNonRosterSystemAdminWorkspace ? {
      id: "platform-system-administrator",
      name: "System administrator",
      initials: "SA",
      accessRole: "hr" as const,
      roleLabel: "Platform administrator",
      team: "Platform administration",
      manager: "",
      company: "mam" as const,
    } : undefined);
  if (!signedInProfile) {
    return <DirectoryLoading
      state={organisationState === "live" ? "unlinked" : organisationState}
      onRetry={() => void loadOrganisation()}
      onSignOut={() => void handleSignOut()}
      signingOut={isSigningOut}
    />;
  }
  const adminProfile: Profile = canManageEmployeeDirectory
    ? { ...signedInProfile, accessRole: "hr" }
    : signedInProfile;
  // A preview is never an HR presentation. HR is an actual database capability,
  // while manager presentation is derived only from active direct reports.
  const previewProfile: Profile | undefined = selectedPreviewCandidate
    ? {
        ...selectedPreviewCandidate,
        accessRole: previewAccessRoleForOrgPerson(selectedPreviewCandidate.id, organisationRows),
      }
    : undefined;
  const isPreviewingEmployeeAccess = Boolean(previewProfile);
  const canRenderPreviewCheckIns = isPreviewingEmployeeAccess && canChangeEmployeeView && Boolean(previewProfile?.id);
  const activeProfile = previewProfile ?? adminProfile;
  const showHrWorkspace = canManageEmployeeDirectory && !isPreviewingEmployeeAccess;
  const topbarSelfProfile: SelfProfileData = selfProfile ?? {
    name: signedInProfile.name,
    title: signedInProfile.roleLabel,
    company: signedInProfile.company,
    team: signedInProfile.team,
    manager: signedInProfile.manager,
  };
  const topbarPreviewFallback: SelfProfileData | null = previewProfile ? {
    name: previewProfile.name,
    title: previewProfile.roleLabel,
    company: previewProfile.company,
    team: previewProfile.team,
    manager: previewProfile.manager,
  } : null;
  const authorisedPreviewProfile = selectedEmployeeProfile && selectedEmployeeProfile.personId === previewProfile?.id
    ? selectedEmployeeProfile
    : null;
  // The top-right card changes with the employee view. Until the dedicated
  // HR-only profile request completes, it shows only public organisation data
  // and remains non-editable rather than exposing stale private contact data.
  const topbarProfile: SelfProfileData = isPreviewingEmployeeAccess
    ? authorisedPreviewProfile
      ? authorisedPreviewProfile
      : topbarPreviewFallback ?? topbarSelfProfile
    : topbarSelfProfile;
  const topbarProfileLoading = isPreviewingEmployeeAccess
    ? !authorisedPreviewProfile && !selectedEmployeeProfileError
    : !isNonRosterSystemAdminWorkspace && (!selfProfile || selfProfileLoading);
  const isNonRosterAdminHrWorkspace = isNonRosterSystemAdminWorkspace && !isPreviewingEmployeeAccess;

  // The capability is issued by the server-side leave policy. Change profile
  // only narrows the displayed employee; it never changes the Super Admin's
  // reviewer authority.
  const canReviewLeave = canReviewLeaveWorkspace;
  // Super Admin keeps full operational access while Change Profile is active.
  // The selected target is passed only to the guarded Server Action; auth and
  // audit authority remain with the real Super Admin account.
  const canApplyForLeave = !isNonRosterSystemAdminWorkspace || isPreviewingEmployeeAccess;
  // The server-projected per-request capability remains the source of truth.
  // This only prevents a Change profile or non-roster platform workspace from
  // presenting an impossible cancellation control.
  const canCancelOwnApprovedLeave = !isNonRosterSystemAdminWorkspace
    || isPreviewingEmployeeAccess;
  const viewTitles = getViewTitles(activeProfile, calendarMonth, canReviewLeave);
  // The durable workspace/calendar RPCs have already applied the current
  // session's server-side scope. Do not re-derive access in the browser from a
  // mutable name or hierarchy snapshot; that could hide a valid immutable
  // assignment after an organisation edit.
  const visibleRequests = isPreviewingEmployeeAccess
    ? getEmployeePreviewRequests(requests, activeProfile)
    : requests;
  const calendarRequests = isPreviewingEmployeeAccess
    ? getEmployeePreviewRequests(calendarEntries, activeProfile)
    : calendarEntries;
  // Change Profile changes presentation, not the Super Admin's authority.
  // Keep the complete authorised calendar available so the profile switch
  // never removes a function the real Super Admin can safely exercise.
  const calendarCheckIns = checkInCalendarEntries;
  const approvalQueue = canReviewLeave
    ? visibleRequests.filter((request) => request.canDecide)
    : [];
  const myRequests = requests.filter((request) => request.personId === activeProfile.id);
  const filteredRequests = visibleRequests.filter((request) => {
    return statusFilter === "All" || request.status === statusFilter;
  });
  const selectedRegisterRequest = filteredRequests.find((request) => request.id === selectedRequestId) ?? filteredRequests[0];
  const selectedApprovalRequest = approvalQueue.find((request) => request.id === selectedRequestId) ?? approvalQueue[0];
  const selectedRequest = leaveSection === "approvals" ? selectedApprovalRequest : selectedRegisterRequest;
  const attachmentsByRequestId = new Map<string, LeaveAttachment[]>();
  leaveAttachments.forEach((attachment) => {
    const current = attachmentsByRequestId.get(attachment.leaveRequestId) ?? [];
    current.push(attachment);
    attachmentsByRequestId.set(attachment.leaveRequestId, current);
  });

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
      // Start date is HR-only and is deliberately absent from the public org
      // projection. A null value tells the hardened RPC to preserve it.
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

  async function saveMyProfile(changes: SelfProfileChanges) {
    if (!selfProfile) throw new Error("Your profile is still loading.");
    const updated = await updateCurrentEmployeeSelfProfile({
      ...changes,
      detailVersion: selfProfile.detailVersion,
    });
    setSelfProfile(updated);
    // A self-service edit deliberately triggers the same public-row realtime
    // refresh used by HR. Update the local HR directory immediately too.
    setEmployeeDirectoryRefreshKey((current) => current + 1);
    // Update the current browser's recurring birthday marker without waiting
    // for its own Realtime invalidation event.
    void refreshLeaveWorkspace();
    return { message: "Your contact details are saved." };
  }

  async function saveSelectedEmployeeProfile(changes: SelfProfileChanges) {
    if (!canPreviewEmployeeAccess || !previewProfile || !selectedEmployeeProfile || selectedEmployeeProfile.personId !== previewProfile.id) {
      throw new Error("The selected employee profile is still loading.");
    }
    const updated = await updateSelectedEmployeeProfile({
      ...changes,
      personId: selectedEmployeeProfile.personId,
      detailVersion: selectedEmployeeProfile.detailVersion,
    });
    setSelectedEmployeeProfile(updated);
    if (updated.personId === currentPersonId) setSelfProfile(updated);
    // Keep the HR directory and the public organisation tree in step with the
    // selected profile change, without publishing private contact fields.
    setEmployeeDirectoryRefreshKey((current) => current + 1);
    void refreshLeaveWorkspace();
    return { message: `${updated.name}'s contact details are saved.` };
  }

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  async function uploadLeaveAttachments(requestId: string, files: File[]) {
    if (!directorySupabase) return { uploaded: 0, failed: files.map((file) => file.name || "supporting file") };
    const failed: string[] = [];
    let uploaded = 0;
    for (const file of files) {
      let storagePath: string | undefined;
      try {
        const plan = await prepareLeaveRequestAttachmentUpload({
          requestId,
          fileName: file.name,
          mimeType: file.type.toLowerCase(),
          sizeBytes: file.size,
        });
        storagePath = plan.storagePath;
        const { error: storageError } = await directorySupabase.storage
          .from("leave-evidence")
          .upload(plan.storagePath, file, {
            cacheControl: "0",
            contentType: plan.mimeType,
            upsert: false,
          });
        if (storageError) throw new Error("Storage upload failed.");
        await completeLeaveRequestAttachmentUpload({ storagePath: plan.storagePath });
        uploaded += 1;
      } catch {
        if (storagePath) {
          try {
            await discardLeaveRequestAttachmentUpload({ storagePath });
          } catch {
            // A retention job removes any unregistered private object if the
            // upload reached Storage before registration failed.
          }
        }
        failed.push(file.name || "supporting file");
      }
    }
    return { uploaded, failed };
  }

  function changeEmployeeAccessPreview(personId: string) {
    if (!canPreviewEmployeeAccess) return;
    const nextProfile = directoryProfiles.find((profile) => profile.id === personId);
    if (personId && !nextProfile) return;

    setPreviewPersonId(nextProfile?.id ?? "");
    setProfilePickerOpen(false);
    setProfilePickerQuery("");
    setSelectedEmployeeProfile(null);
    setSelectedEmployeeProfileErrorState(null);
    setShowRequestForm(false);
    setFormError("");
    setManagerNote("");
    setCancellationRequestId(null);
    setCancellationFocusRequestId(null);
    setCancellationError("");
    setCancelledRequestId(null);
    setSelectedRequestId("");
    setLeaveSection("requests");

    if (nextProfile) {
      announce(`Previewing ${nextProfile.name}'s employee access. HR tools and private records are hidden.`);
    } else {
      announce("Returned to Super Admin.");
    }
  }

  function chooseLeaveSection(section: LeaveSection, requestedId?: string) {
    if (section === "approvals" && !canReviewLeave) return;
    setCancellationRequestId(null);
    setCancellationFocusRequestId(null);
    setCancellationError("");
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
    else {
      setCancellationRequestId(null);
      setCancellationFocusRequestId(null);
      setCancellationError("");
    }
    setActiveView(view);
    scrollPageToTop();
  }

  function changeLeaveStatusFilter(filter: "All" | RequestStatus) {
    setStatusFilter(filter);
    setCancellationRequestId(null);
    setCancellationFocusRequestId(null);
    setCancellationError("");
  }

  function openLeaveRequestForm() {
    if (!canApplyForLeave || isMutating) return;
    setFormError("");
    setShowRequestForm(true);
  }

  function selectRequest(id: string, section: LeaveSection = "requests") {
    setSelectedRequestId(id);
    setManagerNote("");
    setCancellationRequestId(null);
    setCancellationFocusRequestId(null);
    setCancellationError("");
    setCancelledRequestId(null);
    chooseLeaveSection(section, id);
    setActiveView("leave");
    scrollPageToTop();
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isMutating || (!isPreviewingEmployeeAccess && isNonRosterSystemAdminWorkspace)) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const leaveType = String(data.get("leaveType"));
    const startDate = String(data.get("startDate"));
    const endDate = String(data.get("endDate"));
    const startTime = String(data.get("startTime") ?? "").trim();
    const endTime = String(data.get("endTime") ?? "").trim();
    const employeeNote = String(data.get("employeeNote"));
    const attachmentFiles = data.getAll("attachments").filter((entry): entry is File => (
      entry instanceof File && Boolean(entry.name)
    ));
    const attachmentValidationError = validateLeaveAttachmentFiles(attachmentFiles);
    if (attachmentValidationError) {
      setFormError(attachmentValidationError);
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

    setIsMutating(true);
    try {
      const requestInput = {
        leaveType,
        startDate,
        endDate,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        employeeNote,
      };
      const next = isPreviewingEmployeeAccess && previewProfile
        ? await submitLeaveRequestForSelectedEmployee(previewProfile.id, requestInput)
        : await submitLeaveRequest(requestInput);
      const attachmentResult = attachmentFiles.length
        ? await uploadLeaveAttachments(next.id, attachmentFiles)
        : { uploaded: 0, failed: [] as string[] };
      await refreshLeaveWorkspace();
      setSelectedRequestId(next.id);
      setShowRequestForm(false);
      setFormError("");
      form.reset();
      navigate("leave");
      if (attachmentResult.failed.length) {
        announce(`Leave request saved. ${attachmentResult.failed.length} supporting ${attachmentResult.failed.length === 1 ? "file was" : "files were"} not attached; open the request to retry.`);
      } else {
        announce(next.assignedReviewerLabel
          ? `Your leave request is pending review by ${next.assignedReviewerLabel}.`
          : "Your leave request is pending review by an authorised reviewer.");
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The leave request could not be saved. Refresh and try again.");
    } finally {
      setIsMutating(false);
    }
  }

  async function addSupportingFiles(requestId: string, files: File[]) {
    if (!files.length || isMutating) return;
    const request = requests.find((candidate) => candidate.id === requestId);
    if (!request || request.canAttach !== true) {
      announce("Supporting files can only be added to an eligible submitted or approved leave request.");
      return;
    }
    const validationError = validateLeaveAttachmentFiles(files, attachmentsByRequestId.get(requestId)?.length ?? 0);
    if (validationError) {
      announce(validationError);
      return;
    }
    setIsMutating(true);
    try {
      const result = await uploadLeaveAttachments(requestId, files);
      await refreshLeaveWorkspace();
      if (result.failed.length) {
        announce(`${result.uploaded ? `${result.uploaded} added. ` : ""}${result.failed.length} ${result.failed.length === 1 ? "file was" : "files were"} not attached; choose ${result.failed.length === 1 ? "it" : "them"} again to retry.`);
      } else {
        announce(`${result.uploaded} supporting ${result.uploaded === 1 ? "file was" : "files were"} added.`);
      }
    } finally {
      setIsMutating(false);
    }
  }

  async function decideRequest(status: "Approved" | "Declined") {
    if (!selectedRequest || isMutating || !canReviewLeave) return;
    if (status === "Declined" && !managerNote.trim()) {
      announce("Add a decision note before declining this request.");
      return;
    }
    setIsMutating(true);
    try {
      const decided = await decideLeaveRequest({
        requestId: selectedRequest.id,
        status,
        managerNote,
      });
      await refreshLeaveWorkspace();
      const nextApproval = approvalQueue.find((request) => request.id !== selectedRequest.id);
      setSelectedRequestId(nextApproval?.id ?? decided.id);
      setManagerNote("");
      announce(`Leave request was ${status.toLowerCase()}.`);
    } catch (error) {
      announce(error instanceof Error ? error.message : "The leave decision could not be saved. Refresh and try again.");
    } finally {
      setIsMutating(false);
    }
  }

  function startLeaveCancellation(requestId: string) {
    if (
      !selectedRequest
      || selectedRequest.id !== requestId
      || selectedRequest.status !== "Approved"
      || selectedRequest.canCancel !== true
      || !canCancelOwnApprovedLeave
      || isMutating
    ) return;

    setCancellationError("");
    setCancellationFocusRequestId(null);
    setCancellationRequestId(requestId);
  }

  function dismissLeaveCancellation() {
    if (isMutating) return;
    const requestId = cancellationRequestId;
    setCancellationRequestId(null);
    setCancellationFocusRequestId(requestId);
    setCancellationError("");
  }

  async function confirmLeaveCancellation(requestId: string) {
    if (
      !selectedRequest
      || selectedRequest.id !== requestId
      || selectedRequest.status !== "Approved"
      || selectedRequest.canCancel !== true
      || !canCancelOwnApprovedLeave
      || cancellationRequestId !== requestId
      || isMutating
    ) return;

    setIsMutating(true);
    setCancellationError("");
    try {
      const cancelled = await cancelMyApprovedLeaveRequest({ requestId });
      setCancellationRequestId(null);
      setCancellationFocusRequestId(null);
      setCancelledRequestId(cancelled.id);
      await refreshLeaveWorkspace();
      setSelectedRequestId(requestId);
      announce("Your future leave was cancelled. It has been removed from the team calendar; the approval history is kept.");
    } catch (error) {
      setCancellationError(error instanceof Error ? error.message : "The leave could not be cancelled. Refresh and try again.");
    } finally {
      setIsMutating(false);
    }
  }

  const navItems = [
    { id: "home" as AppView, label: "Home", icon: LayoutDashboard },
    { id: "leave" as AppView, label: "Leave", icon: ClipboardList, badge: canReviewLeave ? approvalQueue.length : undefined },
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
              <button aria-current={activeView === item.id ? "page" : undefined} className={`${styles.navItem} ${activeView === item.id ? styles.navItemActive : ""}`} type="button" onClick={() => navigate(item.id)} key={item.id}>
                <Icon size={17} strokeWidth={1.8} /><b>{item.label}</b>{item.badge ? <i>{item.badge}</i> : null}
              </button>
            );
          })}
        </nav>
        {canPreviewEmployeeAccess ? (
          <section
            aria-label="Employee access preview"
            className={styles.viewSwitcher}
            data-previewing={isPreviewingEmployeeAccess || undefined}
          >
            <label className={styles.viewSwitcherHeading} htmlFor="employee-access-view">
              <Eye aria-hidden="true" size={17} />
              <span>
                <strong>Change profile</strong>
                <small role="status">{previewProfile
                  ? selectedEmployeeProfileError
                    ? `${previewProfile.name}'s profile is unavailable`
                    : !authorisedPreviewProfile
                      ? `Loading ${previewProfile.name}'s profile`
                      : `Viewing ${previewProfile.name}`
                  : "Super Admin"}</small>
              </span>
            </label>
            <button
              type="button"
              className={styles.viewPickerTrigger}
              onClick={() => {
                setProfilePickerQuery("");
                setProfilePickerOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={profilePickerOpen}
            >
              <span>{previewProfile?.name ?? "Super Admin"}</span>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
            {isPreviewingEmployeeAccess ? (
              <div className={styles.viewSwitcherActive} id="employee-access-preview-note">
                <small>Employee workspace preview · signed in as {signedInProfile.name}</small>
                <button type="button" onClick={() => changeEmployeeAccessPreview("")}>
                  <RotateCcw aria-hidden="true" size={14} /> Return to Super Admin
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
            {profilePickerOpen ? <div className={styles.profilePickerBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProfilePicker(); }}>
          <section className={styles.profilePicker} ref={profilePickerDialogRef} role="dialog" aria-modal="true" aria-labelledby="profile-picker-title" tabIndex={-1}>
            <header className={styles.profilePickerHeader}>
              <div><span>Super Admin</span><h2 id="profile-picker-title">Change profile</h2></div>
              <button type="button" className={styles.profilePickerClose} onClick={closeProfilePicker} aria-label="Close profile picker"><X size={17} /></button>
            </header>
            <label className={styles.profilePickerSearch}>
              <Search aria-hidden="true" size={16} />
              <span className={styles.srOnly}>Search profiles</span>
              <input ref={profilePickerSearchRef} value={profilePickerQuery} onChange={(event) => setProfilePickerQuery(event.target.value)} placeholder="Search name, role or team" type="search" />
            </label>
            <div className={styles.profilePickerList}>
              <button type="button" className={`${styles.profilePickerOption} ${!previewProfile ? styles.profilePickerOptionActive : ""}`} onClick={() => changeEmployeeAccessPreview("")}>
                <span className={styles.profilePickerAvatar}>SA</span><span><strong>Super Admin</strong><small>Full system access</small></span>
              </button>
              {profilePickerResults.map((profile) => <button type="button" key={profile.id} className={`${styles.profilePickerOption} ${previewProfile?.id === profile.id ? styles.profilePickerOptionActive : ""}`} onClick={() => changeEmployeeAccessPreview(profile.id)}>
                <span className={styles.profilePickerAvatar}>{profile.initials}</span><span><strong>{profile.name}</strong><small>{profile.roleLabel}{profile.team ? ` · ${profile.team}` : ""}</small></span>
              </button>)}
              {!profilePickerResults.length ? <p className={styles.profilePickerEmpty}>No profiles match that search.</p> : null}
            </div>
          </section>
        </div> : null}
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.mobileBrand}><BrandMark compact /></div>
          <div className={styles.topActions}>
            {organisationState !== "live" ? (
              <span className={styles.demoStatus} data-state={organisationState} role="status">
                <i />
                {organisationState === "connecting" ? "Connecting" : "Directory issue"}
              </span>
            ) : null}
            {directorySupabase ? <button className={styles.signOutButton} type="button" onClick={() => void handleSignOut()} disabled={isSigningOut} aria-label="Sign out"><LogOut size={15} /><span className={styles.actionLabel}>{isSigningOut ? "Signing out…" : "Sign out"}</span></button> : null}
            {isNonRosterAdminHrWorkspace ? (
              <span className={styles.demoStatus} title="This platform administrator is not an employee profile.">
                <ShieldCheck aria-hidden="true" size={15} /> Platform administrator
              </span>
            ) : <SelfProfileMenu
                disabled={topbarProfileLoading || Boolean(selectedEmployeeProfileError)}
                mode={isPreviewingEmployeeAccess ? "hr-preview" : "self"}
                onSave={isPreviewingEmployeeAccess ? saveSelectedEmployeeProfile : saveMyProfile}
                profile={topbarProfile}
                viewerName={isPreviewingEmployeeAccess ? signedInProfile.name : undefined}
              />}
          </div>
        </header>

        <main className={styles.main} id="main-content">
          {activeView !== "people" ? <section className={styles.pageHeader}>
            <div><h1>{viewTitles[activeView].title}</h1>{viewTitles[activeView].helper ? <p>{viewTitles[activeView].helper}</p> : null}</div>
            {activeView === "leave" && canApplyForLeave ? <button className={`${styles.primaryButton} ${styles.applyForLeaveButton}`} type="button" onClick={openLeaveRequestForm} disabled={isMutating} aria-haspopup="dialog"><Plus aria-hidden="true" size={17} /><span>Apply for leave</span></button> : null}
          </section> : null}

          {leaveDataError && activeView !== "people" ? <div className={styles.loadErrorAction} role="alert"><span>{leaveDataError}</span><button type="button" onClick={() => void refreshLeaveWorkspace()} disabled={leaveDataLoading}>{leaveDataLoading ? "Retrying…" : "Retry"}</button></div> : null}
          {selfProfileError && !isPreviewingEmployeeAccess && !isNonRosterSystemAdminWorkspace ? <div className={styles.loadErrorAction} role="alert"><span>{selfProfileError}</span><button type="button" onClick={() => void loadSelfProfile()} disabled={selfProfileLoading}>{selfProfileLoading ? "Retrying…" : "Retry profile"}</button></div> : null}
          {selectedEmployeeProfileError && isPreviewingEmployeeAccess ? <div className={styles.loadErrorAction} role="alert"><span>{selectedEmployeeProfileError}</span><button type="button" onClick={() => setSelectedEmployeeProfileReloadKey((current) => current + 1)}>Retry profile</button></div> : null}
          {organisationAccessError && activeView === "people" ? <div className={styles.loadErrorAction} role="alert"><span>{organisationAccessError}</span><button type="button" onClick={() => void loadOrganisation()}>Retry permissions</button></div> : null}
          {activeView === "home" ? <HomeView profile={activeProfile} requests={calendarRequests} myRequests={myRequests} pending={approvalQueue} canReview={canReviewLeave} onNavigate={navigate} onSelect={selectRequest} isNonRosterSystemAdmin={isNonRosterAdminHrWorkspace} /> : null}
          {activeView === "leave" ? <LeaveView profile={activeProfile} section={leaveSection} requests={filteredRequests} allRequests={visibleRequests} selected={selectedRequest} filter={statusFilter} pending={approvalQueue} canReview={canReviewLeave} selectedId={selectedRequestId} note={managerNote} calendarRequests={calendarRequests} attachmentsByRequestId={attachmentsByRequestId} busy={isMutating} readOnly={isNonRosterSystemAdminWorkspace && !isPreviewingEmployeeAccess} hidePrivateDetails={isNonRosterSystemAdminWorkspace && !isPreviewingEmployeeAccess} canCancelOwnApprovedLeave={canCancelOwnApprovedLeave} cancellationRequestId={cancellationRequestId} cancellationError={cancellationError} cancelledRequestId={cancelledRequestId} onFilter={changeLeaveStatusFilter} onSection={chooseLeaveSection} onNote={setManagerNote} onSelect={selectRequest} onDecision={decideRequest} onAddSupportingFiles={addSupportingFiles} onStartCancellation={startLeaveCancellation} onDismissCancellation={dismissLeaveCancellation} onConfirmCancellation={confirmLeaveCancellation} /> : null}
          {activeView === "calendar" ? <CalendarView birthdays={calendarBirthdays} checkIns={calendarCheckIns} requests={calendarRequests} month={calendarMonth} loading={leaveDataLoading} onNextMonth={() => setCalendarMonth((current) => startOfCalendarMonth(new Date(current.getFullYear(), current.getMonth() + 1, 1)))} onPreviousMonth={() => setCalendarMonth((current) => startOfCalendarMonth(new Date(current.getFullYear(), current.getMonth() - 1, 1)))} onToday={() => setCalendarMonth(startOfCalendarMonth(new Date()))} /> : null}
          <div hidden={activeView !== "people"}>
            <PeopleOperationsDemo
              key={showHrWorkspace ? "hr-directory" : isPreviewingEmployeeAccess ? `employee-preview:${activeProfile.id}` : "standard-people"}
              activeProfile={activeProfile}
              organisationProfiles={organisationPeople}
              canEditOrganisation={canEditOrganisation && showHrWorkspace}
              canArrangeOrganisation={canEditOrganisation && showHrWorkspace}
              isAccessPreview={isPreviewingEmployeeAccess}
              onCreateOrganisationPerson={createOrganisationPerson}
              onUpdateOrganisationPerson={updateOrganisationPerson}
              onOpenEmployeeDirectoryRecord={showHrWorkspace ? setEmployeeDirectorySelectedPersonId : undefined}
              renderEmployeeDirectory={showHrWorkspace ? <EmployeeDirectory
                onRecordsChanged={async () => {
                  // The directory save may have added or changed a birthday.
                  // Reload through the narrow calendar RPC, not from directory
                  // records or a Realtime payload containing private fields.
                  void refreshLeaveWorkspace();
                  await Promise.all([loadOrganisation(), loadAccounts()]);
                }}
                onSelectedPersonId={setEmployeeDirectorySelectedPersonId}
                refreshKey={employeeDirectoryRefreshKey}
                selectedPersonId={employeeDirectorySelectedPersonId}
              /> : undefined}
              renderCheckInRegister={showHrWorkspace
                ? <CheckInRegister
                    onRecordsChanged={() => void refreshLeaveWorkspace()}
                    resources={checkInResources}
                  />
                : (canViewCheckIns || canRenderPreviewCheckIns)
                  ? <CheckInWorkspace
                      previewPersonId={canRenderPreviewCheckIns ? previewProfile?.id : undefined}
                      readOnly={false}
                      onRecordsChanged={() => void refreshLeaveWorkspace()}
                      resources={checkInResources}
                    />
                  : undefined}
              renderCheckInTasks={(canViewCheckInTasks || canRenderPreviewCheckIns)
                ? <CheckInTasks
                    previewPersonId={canRenderPreviewCheckIns ? previewProfile?.id : undefined}
                    readOnly={false}
                  />
                : undefined}
              renderAccounts={isAdmin && showHrWorkspace ? accountsLoading
                ? <div className={styles.emptyState}><UsersRound size={24} /><strong>Loading accounts</strong></div>
                : accountsError
                ? <div className={styles.emptyState}><ShieldCheck size={24} /><strong>Accounts could not be loaded</strong><span>{accountsError}</span><button className={styles.primaryButton} type="button" onClick={() => void loadAccounts()}>Retry accounts</button></div>
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
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeLeaveRequestForm()}>
          <section className={styles.modal} ref={leaveRequestDialogRef} role="dialog" aria-modal="true" aria-labelledby="new-request-title" tabIndex={-1}>
            <header><div><span>New request</span><h2 id="new-request-title">Request leave</h2></div><button type="button" onClick={closeLeaveRequestForm} aria-label="Close request form"><X size={19} /></button></header>
            <div className={styles.formPerson}><span className={styles.avatarOrange}>{activeProfile.initials}</span><span><strong>{activeProfile.name}</strong><small>{activeProfile.team} · Your request will be routed to an authorised reviewer</small></span></div>
            <form className={styles.form} onSubmit={submitRequest}>
              <label><span>Leave type</span><select ref={leaveRequestInitialFocusRef} name="leaveType" defaultValue="Annual leave" required><option>Annual leave</option><option>Sick leave</option><option>Carer&apos;s leave</option><option>Unpaid leave</option></select></label>
              <div className={styles.formRow}><label><span>Start date</span><input name="startDate" type="date" defaultValue={nextAvailableLeaveDate()} required /></label><label><span>End date</span><input name="endDate" type="date" defaultValue={nextAvailableLeaveDate()} required /></label></div>
              <fieldset className={styles.timeRange}><legend>Start and end times <small>Optional</small></legend><div className={styles.formRow}><label><span>From · first day</span><select name="startTime" defaultValue=""><option value="">Select time</option>{START_TIME_OPTIONS.map((option) => <option value={option.value} key={`start-${option.value}`}>{option.label}</option>)}</select></label><label><span>To · last day</span><select name="endTime" defaultValue=""><option value="">Select time</option>{END_TIME_OPTIONS.map((option) => <option value={option.value} key={`end-${option.value}`}>{option.label}</option>)}</select></label></div><p>6:00 am–6:00 pm in 15-minute intervals. For multiple dates, these apply to the first and last day. Leave both blank for full working days.</p></fieldset>
              <label><span>Note for your reviewer <small>Optional</small></span><textarea name="employeeNote" rows={3} placeholder="Add only what your reviewer needs to decide." /></label>
              <label className={styles.attachmentField}>
                <span>Supporting files <small>Optional</small></span>
                <input className={styles.fileInput} name="attachments" type="file" accept={LEAVE_ATTACHMENT_ACCEPT} multiple disabled={isMutating} />
                <small>PDF or image files only · up to 10 files, 5 MB each. Private to the employee, authorised reviewer and HR.</small>
              </label>
              <div className={styles.privacyNote}><ShieldCheck size={17} /><span>Your note is private to you, your approver and HR. Coworkers only see that you are unavailable.</span></div>
              {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
              <footer><button className={styles.secondaryButton} type="button" onClick={closeLeaveRequestForm} disabled={isMutating}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={isMutating}>{isMutating ? "Saving…" : "Send request"} <ArrowUpRight size={16} /></button></footer>
            </form>
          </section>
        </div>
      ) : null}

      <div className={`${styles.toast} ${toast ? styles.toastVisible : ""}`} role="status" aria-live="polite"><CheckCircle2 size={17} />{toast}</div>
    </div>
  );
}

function DirectoryLoading({
  state,
  onRetry,
  onSignOut,
  signingOut,
}: {
  state: DirectoryState | "unlinked";
  onRetry: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const isUnlinked = state === "unlinked";
  const hasError = state === "error" || isUnlinked;
  return <div className={styles.shell} data-company="mam">
    <aside className={styles.sidebar} aria-label="Safer People System navigation">
      <div className={styles.brandRow}><BrandMark /></div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.topbar} />
      <main className={styles.main} id="main-content">
        <div className={styles.emptyState}>
          <UsersRound size={25} />
          <strong>{isUnlinked ? "Your account is not linked to an active employee" : state === "error" ? "The directory could not be loaded" : "Loading your profile"}</strong>
          <span>{isUnlinked
            ? "Retry after HR links this login to your directory record, or sign out and use another account."
            : state === "error"
              ? "Retry the directory connection or ask the system administrator to check your account link."
              : "Connecting to the live organisation directory…"}</span>
          {hasError ? <div className={styles.directoryRecoveryActions}>
            <button className={styles.secondaryButton} type="button" onClick={onRetry}>Retry directory</button>
            <button className={styles.primaryButton} type="button" onClick={onSignOut} disabled={signingOut}>{signingOut ? "Signing out…" : "Sign out"}</button>
          </div> : null}
        </div>
      </main>
    </div>
  </div>;
}

function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`${styles.status} ${styles[`status${status}`]}`}><i />{status}</span>;
}

function HomeView({ profile, requests, myRequests, pending, canReview, onNavigate, onSelect, isNonRosterSystemAdmin = false }: { profile: Profile; requests: LeaveRequest[]; myRequests: LeaveRequest[]; pending: LeaveRequest[]; canReview: boolean; onNavigate: (view: AppView, section?: LeaveSection) => void; onSelect: (id: string, section?: LeaveSection) => void; isNonRosterSystemAdmin?: boolean }) {
  if (isNonRosterSystemAdmin) {
    return (
      <div className={styles.dashboard}>
        <section className={styles.panel}>
          <div className={styles.emptyState}>
            <ShieldCheck size={24} />
            <strong>Super Admin</strong>
            <span>This account has no employee profile or leave record. Use Change profile to inspect an employee workspace, or open People to manage the directory.</span>
          </div>
        </section>
      </div>
    );
  }

  const activeOwnRequests = myRequests.filter((request) => request.status !== "Cancelled");
  const nextOwn = activeOwnRequests.find((request) => request.status === "Pending") ?? activeOwnRequests[0];
  const attentionRequests = canReview ? pending : requests.filter((request) => request.status === "Pending" && request.personId !== profile.id);
  const attentionTitle = canReview ? "Needs review" : "Pending leave";
  const recordSection: LeaveSection = canReview ? "approvals" : "requests";

  if (!canReview) {
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
          <PanelHeader title={attentionTitle} action={canReview ? "Open queue" : "View requests"} onAction={() => onNavigate("leave", recordSection)} />
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

function LeaveView({ profile, section, requests, allRequests, selected, filter, pending, canReview, selectedId, note, calendarRequests, attachmentsByRequestId, busy, readOnly, hidePrivateDetails, canCancelOwnApprovedLeave, cancellationRequestId, cancellationError, cancelledRequestId, onFilter, onSection, onNote, onSelect, onDecision, onAddSupportingFiles, onStartCancellation, onDismissCancellation, onConfirmCancellation }: { profile: Profile; section: LeaveSection; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected?: LeaveRequest; filter: "All" | RequestStatus; pending: LeaveRequest[]; canReview: boolean; selectedId: string; note: string; calendarRequests: LeaveRequest[]; attachmentsByRequestId: Map<string, LeaveAttachment[]>; busy: boolean; readOnly: boolean; hidePrivateDetails: boolean; canCancelOwnApprovedLeave: boolean; cancellationRequestId: string | null; cancellationError: string; cancelledRequestId: string | null; onFilter: (filter: "All" | RequestStatus) => void; onSection: (section: LeaveSection) => void; onNote: (note: string) => void; onSelect: (id: string, section?: LeaveSection) => void; onDecision: (status: "Approved" | "Declined") => void; onAddSupportingFiles: (requestId: string, files: File[]) => Promise<void>; onStartCancellation: (requestId: string) => void; onDismissCancellation: () => void; onConfirmCancellation: (requestId: string) => void }) {
  return (
    <section className={styles.leaveDesk}>
      {canReview ? (
        <div className={styles.leaveSwitch} aria-label="Leave workspace">
          <button className={section === "requests" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "requests"} onClick={() => onSection("requests")}>
            <strong>Leave register</strong><i>{allRequests.length}</i>
          </button>
          <button className={section === "approvals" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "approvals"} onClick={() => onSection("approvals")}>
            <strong>Approvals</strong><i>{pending.length}</i>
          </button>
        </div>
      ) : null}
      {section === "requests" ? <RequestsView profile={profile} requests={requests} allRequests={allRequests} selected={selected} filter={filter} canReview={canReview} attachmentsByRequestId={attachmentsByRequestId} readOnly={readOnly} hidePrivateDetails={hidePrivateDetails} canCancelOwnApprovedLeave={canCancelOwnApprovedLeave} cancellationRequestId={cancellationRequestId} cancellationError={cancellationError} cancelledRequestId={cancelledRequestId} busy={busy} onFilter={onFilter} onSelect={(id) => onSelect(id, "requests")} onAddSupportingFiles={onAddSupportingFiles} onStartCancellation={onStartCancellation} onDismissCancellation={onDismissCancellation} onConfirmCancellation={onConfirmCancellation} /> : null}
      {section === "approvals" && canReview ? <ApprovalsView pending={pending} selected={selected} selectedId={selectedId} note={note} requests={calendarRequests} attachmentsByRequestId={attachmentsByRequestId} busy={busy} readOnly={readOnly} hidePrivateDetails={hidePrivateDetails} onNote={onNote} onSelect={(id) => onSelect(id, "approvals")} onDecision={onDecision} /> : null}
    </section>
  );
}

function RequestsView({ profile, requests, allRequests, selected, filter, canReview, attachmentsByRequestId, readOnly, hidePrivateDetails, canCancelOwnApprovedLeave, cancellationRequestId, cancellationError, cancelledRequestId, busy, onFilter, onSelect, onAddSupportingFiles, onStartCancellation, onDismissCancellation, onConfirmCancellation }: { profile: Profile; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected?: LeaveRequest; filter: "All" | RequestStatus; canReview: boolean; attachmentsByRequestId: Map<string, LeaveAttachment[]>; readOnly: boolean; hidePrivateDetails: boolean; canCancelOwnApprovedLeave: boolean; cancellationRequestId: string | null; cancellationError: string; cancelledRequestId: string | null; busy: boolean; onFilter: (filter: "All" | RequestStatus) => void; onSelect: (id: string) => void; onAddSupportingFiles: (requestId: string, files: File[]) => Promise<void>; onStartCancellation: (requestId: string) => void; onDismissCancellation: () => void; onConfirmCancellation: (requestId: string) => void }) {
  const filters: ("All" | RequestStatus)[] = ["All", "Pending", "Approved", "Declined", "Cancelled"];
  const isEmployee = !canReview;
  return (
    <section className={styles.recordsWorkspace}>
      <div className={styles.viewToolbar}>
        <div className={styles.filterTabs}>{filters.map((item) => <button aria-pressed={filter === item} className={filter === item ? styles.filterActive : ""} type="button" onClick={() => onFilter(item)} key={item}>{item}<span>{item === "All" ? allRequests.length : allRequests.filter((request) => request.status === item).length}</span></button>)}</div>
      </div>
      <div className={`${styles.recordsGrid} ${isEmployee ? styles.employeeRecordsGrid : ""} ${!selected ? styles.recordsGridNoDetail : ""}`}>
        <div className={styles.recordsTable} role="table" aria-label="Leave requests">
          <div className={`${styles.tableHead} ${isEmployee ? styles.employeeTableRow : ""}`} role="row">{!isEmployee ? <span>Employee</span> : null}<span>Leave</span><span>Dates</span><span>Duration</span><span>Status</span><span /></div>
          {requests.map((request) => <button className={`${styles.tableRow} ${isEmployee ? styles.employeeTableRow : ""} ${selected?.id === request.id ? styles.tableRowActive : ""}`} type="button" onClick={() => onSelect(request.id)} role="row" key={request.id}>{!isEmployee ? <span><i>{request.initials}</i><b>{request.personId === profile.id ? "You" : request.employee}<small>{request.team}</small></b></span> : null}<span><b>{request.leaveType}</b><small>{request.id}</small></span><span>{request.dateLabel}</span><span>{formatDuration(request)}{formatTimeRange(request) ? <small>{formatTimeRange(request)}</small> : null}</span><span><StatusPill status={request.status} /></span><ChevronRight size={15} /></button>)}
          {!requests.length ? <div className={styles.emptyState}><Search size={23} /><strong>{allRequests.length ? "No requests match this status" : "No leave requests yet"}</strong><span>{allRequests.length ? "Choose another status." : isEmployee ? "Use “New leave request” when you need time away." : "Employee leave requests appear here once they are submitted."}</span></div> : null}
        </div>
        {selected ? <RequestDetail profile={profile} request={selected} attachments={attachmentsByRequestId.get(selected.id) ?? []} canReview={canReview} readOnly={readOnly} hidePrivateDetails={hidePrivateDetails} canCancelOwnApprovedLeave={canCancelOwnApprovedLeave} cancellationRequestId={cancellationRequestId} cancellationError={cancellationError} cancellationSucceeded={cancelledRequestId === selected.id} busy={busy} onAddSupportingFiles={onAddSupportingFiles} onStartCancellation={onStartCancellation} onDismissCancellation={onDismissCancellation} onConfirmCancellation={onConfirmCancellation} /> : null}
      </div>
    </section>
  );
}

function RequestDetail({ profile, request, attachments, canReview, readOnly, hidePrivateDetails, canCancelOwnApprovedLeave, cancellationRequestId, cancellationError, cancellationSucceeded, busy, onAddSupportingFiles, onStartCancellation, onDismissCancellation, onConfirmCancellation }: { profile: Profile; request: LeaveRequest; attachments: LeaveAttachment[]; canReview: boolean; readOnly: boolean; hidePrivateDetails: boolean; canCancelOwnApprovedLeave: boolean; cancellationRequestId: string | null; cancellationError: string; cancellationSucceeded: boolean; busy: boolean; onAddSupportingFiles: (requestId: string, files: File[]) => Promise<void>; onStartCancellation: (requestId: string) => void; onDismissCancellation: () => void; onConfirmCancellation: (requestId: string) => void }) {
  const showEmployee = canReview && request.personId !== profile.id;
  const isApprovedLeave = request.status === "Approved";
  const isConfirmingCancellation = cancellationRequestId === request.id;
  const isCancelled = request.status === "Cancelled" || cancellationSucceeded;
  const canCancel = !readOnly
    && !isCancelled
    && canCancelOwnApprovedLeave
    && isApprovedLeave
    && request.canCancel === true;
  const canAddAttachments = !readOnly && request.canAttach === true;
  return <aside className={styles.detailPanel} aria-label={`${request.id} details`}>
    <header className={!showEmployee ? styles.personalDetailHeader : undefined}>
      {showEmployee ? <span className={styles.avatarOrange}>{request.initials}</span> : null}
      <span><small>{request.id}</small>{showEmployee ? <><h2>{request.employee}</h2><p>{request.team}</p></> : <h2>{request.leaveType}</h2>}</span>
    </header>
    <StatusPill status={request.status} />
    <dl>
      {showEmployee ? <div><dt>Leave type</dt><dd>{request.leaveType}</dd></div> : null}
      <div><dt>When</dt><dd>{request.dateLabel}</dd></div>
      <div><dt>Duration</dt><dd>{formatDurationWithTime(request)}</dd></div>
      <div><dt>Assigned reviewer</dt><dd>{request.approvalRequired ? request.assignedReviewerLabel ?? "Authorised reviewer" : "Not required"}</dd></div>
    </dl>
    {isCancelled ? <section className={styles.cancelLeaveRecorded} role="status"><CheckCircle2 aria-hidden="true" size={17} /><span><strong>Leave cancelled</strong><small>This leave is no longer on the team calendar. Its approval history is kept.</small></span></section> : null}
    {canCancel ? <section className={styles.cancelLeaveAction}>{!isConfirmingCancellation ? <><span>Approved leave</span><p>Need to cancel this future approved leave?</p><button id={cancelLeaveTriggerId(request.id)} className={styles.cancelLeaveButton} type="button" onClick={() => onStartCancellation(request.id)} disabled={busy}><XCircle aria-hidden="true" size={16} /> Cancel leave</button></> : <><span>Cancel approved leave</span><p>This removes the future leave from the team calendar. The approval history is kept.</p><p>Past, same-day, and partly used leave cannot be cancelled here.</p>{cancellationError ? <p className={styles.cancelLeaveError} role="alert">{cancellationError}</p> : null}<div className={styles.cancelLeaveControls}><button className={styles.cancelLeaveKeepButton} type="button" onClick={onDismissCancellation} disabled={busy}>Keep leave</button><button className={styles.cancelLeaveConfirmButton} type="button" onClick={() => onConfirmCancellation(request.id)} disabled={busy}><XCircle aria-hidden="true" size={16} /> {busy ? "Cancelling…" : "Yes, cancel leave"}</button></div></>}</section> : null}
    {!hidePrivateDetails && request.employeeNote ? <section><span>{request.approvalRequired ? "Employee note" : "Private note"}</span><p>{request.employeeNote}</p><small><ShieldCheck size={13} /> {request.approvalRequired ? "Private to employee, approver and HR" : "Private to this person and HR"}</small></section> : null}
    {!hidePrivateDetails && request.managerNote ? <section><span>Reviewer decision note</span><p>{request.managerNote}</p></section> : null}
    {!hidePrivateDetails ? <AttachmentList attachments={attachments} /> : null}
    {!hidePrivateDetails && canAddAttachments ? <section className={styles.attachmentUpload}>
      <span>Supporting files</span>
      <p>{attachments.length ? `${attachments.length} of ${MAX_LEAVE_ATTACHMENTS} files attached.` : "No supporting files added yet."}</p>
      <label className={styles.attachmentUploadButton} data-busy={busy ? "true" : "false"}>
        <Upload aria-hidden="true" size={15} /> {busy ? "Uploading…" : "Add supporting files"}
        <input
          className={styles.srOnly}
          type="file"
          accept={LEAVE_ATTACHMENT_ACCEPT}
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void onAddSupportingFiles(request.id, files);
          }}
        />
      </label>
      <small>PDF or image files only · up to 5 MB each. Files are not malware-scanned; do not upload unsafe or unrelated content.</small>
    </section> : null}
  </aside>;
}

function AttachmentList({ attachments }: { attachments: LeaveAttachment[] }) {
  if (!attachments.length) return null;

  return <section className={styles.attachmentList} aria-label="Supporting files">
    <span><Paperclip aria-hidden="true" size={14} /> Supporting files</span>
    {attachments.map((attachment) => <a href={`/leave/attachments/${attachment.id}`} key={attachment.id}>
      <FileText aria-hidden="true" size={17} />
      <span><strong>{attachment.fileName}</strong><small>{formatFileSize(attachment.sizeBytes)} · Download</small></span>
      <ArrowUpRight aria-hidden="true" size={15} />
    </a>)}
    <small><ShieldCheck aria-hidden="true" size={13} /> Private to the employee, authorised reviewer and HR.</small>
  </section>;
}

function ApprovalsView({ pending, selected, selectedId, note, requests, attachmentsByRequestId, busy, readOnly, hidePrivateDetails, onNote, onSelect, onDecision }: { pending: LeaveRequest[]; selected?: LeaveRequest; selectedId: string; note: string; requests: LeaveRequest[]; attachmentsByRequestId: Map<string, LeaveAttachment[]>; busy: boolean; readOnly: boolean; hidePrivateDetails: boolean; onNote: (note: string) => void; onSelect: (id: string) => void; onDecision: (status: "Approved" | "Declined") => void }) {
  const showQueue = pending.length > 1 || !selected;
  return <div className={`${styles.approvalGrid} ${!selected ? styles.approvalGridEmpty : ""} ${!showQueue ? styles.approvalGridSingle : ""}`}>
    {showQueue ? <section className={`${styles.panel} ${styles.queue}`}><PanelHeader title="Requests" />{pending.length ? pending.map((request) => <button className={selectedId === request.id ? styles.queueActive : ""} type="button" onClick={() => onSelect(request.id)} disabled={busy} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small></span><ChevronRight size={16} /></button>) : <div className={styles.emptyState}><CheckCircle2 size={25} /><strong>Nothing needs review</strong></div>}</section> : null}
    {selected ? <section className={`${styles.panel} ${styles.approvalRecord}`}>
      <header className={styles.approvalHeader}><span className={styles.avatarOrange}>{selected.initials}</span><span><small>{selected.id}</small><h2>{selected.employee}</h2><p>{selected.team}</p></span><StatusPill status={selected.status} /></header>
      <div className={styles.factGrid}><article><CalendarDays size={17} /><span><small>When</small><strong>{selected.dateLabel}</strong></span></article><article><Clock3 size={17} /><span><small>Duration</small><strong>{formatDurationWithTime(selected)}</strong></span></article><article><ClipboardList size={17} /><span><small>Leave type</small><strong>{selected.leaveType}</strong></span></article></div>
      {!hidePrivateDetails && selected.employeeNote ? <div className={styles.privateNote}><span><ShieldCheck size={14} /> Employee note · private</span><p>{selected.employeeNote}</p></div> : null}
      {!hidePrivateDetails ? <AttachmentList attachments={attachmentsByRequestId.get(selected.id) ?? []} /> : null}
      <ApprovalCalendar selected={selected} requests={requests} />
      {selected.status === "Pending" ? <div className={styles.decisionBox}><label><span>Decision note <small>Required when declining</small></span><textarea rows={3} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Add context that will remain with this record." disabled={busy || readOnly} /></label><div><button className={styles.declineButton} type="button" onClick={() => onDecision("Declined")} disabled={busy || readOnly}><XCircle size={16} /> {busy ? "Sending…" : readOnly ? "Preview only" : "Decline"}</button><button className={styles.approveButton} type="button" onClick={() => onDecision("Approved")} disabled={busy || readOnly}><CheckCircle2 size={16} /> {busy ? "Sending…" : readOnly ? "Preview only" : "Approve leave"}</button></div></div> : <div className={styles.decisionRecorded}><CheckCircle2 size={19} /><span><strong>Decision recorded</strong><small>The employee view and leave register show {selected.status.toLowerCase()}.</small></span></div>}
    </section> : null}
  </div>;
}

function ApprovalCalendar({ selected, requests }: { selected: LeaveRequest; requests: LeaveRequest[] }) {
  const days = getApprovalCalendarDays(selected);
  const rangeStart = days[0].iso;
  const rangeEnd = days[days.length - 1].iso;
  const teamLeave = requests.filter((request) => request.id !== selected.id && request.personId !== selected.personId && request.team === selected.team && request.status !== "Declined" && request.status !== "Cancelled" && request.endDate >= rangeStart && request.startDate <= rangeEnd);
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

function CalendarView({
  birthdays,
  checkIns,
  requests,
  month,
  loading,
  onPreviousMonth,
  onNextMonth,
  onToday,
}: {
  birthdays: BirthdayCalendarEntry[];
  checkIns: CheckInCalendarEntry[];
  requests: LeaveRequest[];
  month: Date;
  loading: boolean;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}) {
  const days = getCalendarDays(month);
  const visible = requests.filter((request) => request.status !== "Declined" && request.status !== "Cancelled");
  const monthLabel = getCalendarMonthLabel(month);

  return (
    <section className={`${styles.panel} ${styles.calendarPanel}`}>
      <div className={styles.calendarToolbar}>
        <div className={styles.calendarMonthControls}>
          <button type="button" onClick={onPreviousMonth} aria-label="Previous month" title="Previous month"><ChevronLeft size={17} /></button>
          <strong aria-live="polite">{monthLabel}</strong>
          <button type="button" onClick={onNextMonth} aria-label="Next month" title="Next month"><ChevronRight size={17} /></button>
          <button type="button" onClick={onToday}>Today</button>
        </div>
        <div className={styles.legend} aria-label="Calendar legend">
          <span><i className={styles.legendApproved} />Approved</span>
          <span><i className={styles.legendPending} />Pending</span>
          <span><i className={styles.legendBirthday} />Birthday</span>
          <span><i className={styles.legendCheckIn} />Check-in</span>
        </div>
      </div>
      <div className={styles.calendarWeek}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className={styles.calendarGrid}>
        {days.map((day) => {
          const birthdayEvents = birthdays
            .filter((birthday) => birthdayOccursOnCalendarDate(birthday, day.iso))
            .map((birthday, index) => ({
              kind: "birthday" as const,
              id: `birthday:${birthday.employee}:${birthday.month}:${birthday.day}:${index}`,
              birthday,
            }));
          const leaveEvents = visible
            .filter((request) => day.iso >= request.startDate && day.iso <= request.endDate)
            .map((request) => ({ kind: "leave" as const, id: request.id, request }));
          const checkInEvents = Array.from(new Map(checkIns
            .filter((entry) => entry.dueDate === day.iso)
            .map((entry) => [`${entry.personId}:${entry.milestone}:${entry.dueDate}`, entry])).values());
          // Birthdays and open check-ins are never hidden. Leave entries use
          // any remaining compact slots and keep their existing overflow row.
          const shownLeaveEvents = leaveEvents.slice(0, Math.max(0, 3 - birthdayEvents.length - checkInEvents.length));

          return (
            <div className={`${styles.calendarDay} ${day.inMonth ? "" : styles.calendarMuted}`} key={day.iso}>
              <span>{day.day}</span>
              {birthdayEvents.map((event) => (
                <article className={styles.eventBirthday} key={event.id}>
                  <i aria-hidden="true">BD</i>
                  <b>{event.birthday.employee}<small>Birthday</small></b>
                </article>
              ))}
              {checkInEvents.map((entry) => (
                <article className={styles.eventCheckIn} key={`checkin:${entry.reminderId}`}>
                  <i aria-hidden="true">CI</i>
                  <b>{entry.employee}<small>{checkInMilestoneLabel(entry.milestone)}</small></b>
                </article>
              ))}
              {shownLeaveEvents.map((event) => (
                <article className={event.request.status === "Approved" ? styles.eventApproved : styles.eventPending} key={event.id}>
                  <i>{event.request.initials}</i>
                  <b>{event.request.employee}<small>{event.request.leaveType === "Away" ? "Away" : `${event.request.status} · ${event.request.leaveType}`}</small></b>
                </article>
              ))}
              {leaveEvents.length > shownLeaveEvents.length ? <small className={styles.calendarMore}>+{leaveEvents.length - shownLeaveEvents.length} more leave</small> : null}
            </div>
          );
        })}
      </div>
      <footer className={styles.calendarPrivacy}>
        <ShieldCheck size={15} />
        {loading
          ? "Refreshing calendar…"
          : "Leave reasons and medical leave types are private. Birthdays show only a name and recurring day/month."}
      </footer>
    </section>
  );
}
