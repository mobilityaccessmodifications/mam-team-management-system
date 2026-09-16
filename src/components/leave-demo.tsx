"use client";

import { approvalBalanceCoverage, approvalRequestHours } from "@/lib/leave-priority";

import { ModalBackdrop } from "@/components/ui/modal-backdrop";

import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
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
  Trash2,
  Upload,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { FormEvent, type CSSProperties, type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { ApprovalBalancePill, ApprovalLeaveBalances, LeavePriorityControls, LeaveRequestBalance, SickEvidenceNotice } from "@/components/leave-priority-controls";
import { BALANCE_PENDING_STATUS, sickEvidenceDeadline, type LeaveDecision, type LeavePriorityWorkspace } from "@/lib/leave-priority";
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
  listItAssetsForEmployeePreview,
  listMyItAssets,
} from "@/app/assets/employee-actions";
import {
  listEmployeeSubscriptionsForPreview,
  listMySubscriptions,
} from "@/app/subscriptions/employee-actions";
import {
  cancelMyLeaveRequest,
  cancelSelectedEmployeeLeaveRequest,
  completeLeaveRequestAttachmentUpload,
  decideLeaveRequest,
  deleteLeaveRequestAttachment,
  discardLeaveRequestAttachmentUpload,
  getLeaveWorkspaceData,
  prepareLeaveRequestAttachmentUpload,
  submitLeaveRequest,
  submitLeaveRequestForSelectedEmployee,
  type BirthdayCalendarEntry,
  type CheckInCalendarEntry,
  type LeaveAttachment,
  type LeaveCalendarEntry,
  type LeaveWorkspaceData,
  type LeaveWorkspaceRequest,
  type PayrollBalanceReminderCalendarEntry,
  type SubscriptionReviewCalendarEntry,
} from "@/app/leave/actions";
import { signOut } from "@/app/login/actions";
import {
  loadEmployeeWorkScheduleWorkspace,
  requestEmployeeWorkScheduleChange,
  reviewEmployeeWorkScheduleChange,
} from "@/app/work-schedule/actions";
import {
  AccountManagement,
  type AccountDto,
} from "@/components/account-management";
import { AssetRegister } from "@/components/asset-register";
import { AnalyticsApiManagement } from "@/components/analytics-api-management";
import { getOrganisationPersonWorkEmail } from "@/app/people/actions";
import { CheckInRegister } from "@/components/check-in-register";
import { CheckInWorkspace } from "@/components/check-in-workspace";
import { CheckInTasks } from "@/components/check-in-tasks";
import { EmployeeDirectory } from "@/components/employee-directory";
import { EmployeeTeamDirectory } from "@/components/employee-team-directory";
import { ManagerEmployeeDirectory } from "@/components/manager-employee-directory";
import { PayrollBalanceImporter } from "@/components/payroll-balance-importer";
import { SubscriptionCredentialVault } from "@/components/subscription-credential-vault";
import { SubscriptionRegister } from "@/components/subscription-register";
import { TeamCalendar } from "@/components/team-calendar";
import {
  WorkScheduleHome,
  WorkScheduleTasks,
} from "@/components/work-schedule-workflow";
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
import type {
  EmployeeWorkingDayTime,
  EmployeeWorkingWeekday,
} from "@/lib/employee-directory-types";
import type {
  WorkScheduleMutationResult,
  WorkScheduleWorkspace,
} from "@/lib/work-schedule-types";

type AppView = "home" | "leave" | "calendar" | "people";
type LeaveSection = "requests" | "approvals" | "balance";

function resolveAuthorisedLeaveSection(
  section: LeaveSection,
  canReview: boolean,
  canAccessBalance: boolean,
): LeaveSection {
  if (section === "approvals" && !canReview) return "requests";
  if (section === "balance" && !canAccessBalance) return "requests";
  return section;
}

function revealSelectedLeaveTab(node: HTMLButtonElement | null) {
  if (!node || typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    if (!node.isConnected) return;
    node.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  });
}

type RequestStatus = "Pending" | "Approved" | "Declined" | "Cancelled" | typeof BALANCE_PENDING_STATUS;
type AccessRole = "hr" | "manager" | "employee";

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
  fullDayHours?: number;
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
  evidenceDueDate?: string;
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

function getApprovalCalendarDays(request: LeaveRequest, expanded = false) {
  const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const first = new Date(`${request.startDate}T12:00:00`);
  const last = new Date(`${request.endDate}T12:00:00`);

  if (expanded) {
    first.setDate(first.getDate() - 21);
    last.setDate(last.getDate() + 21);
  }

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

function checkInMilestoneLabel(milestone: CheckInCalendarEntry["milestone"]) {
  if (milestone === "2_week") return "2-week check-in";
  if (milestone === "1_month") return "1-month check-in";
  if (milestone === "3_month") return "3-month check-in";
  return "5-month check-in";
}

function getEmployeePreviewRequests(
  requests: LeaveRequest[],
  profile: Profile,
  organisationRows: InternalOrgRow[],
  canViewReportingSubtree: boolean,
) {
  // Change profile is a Super Admin-only projection. An employee preview is
  // limited to that person's own register, while a manager preview mirrors
  // the manager's approval workspace: their own requests plus every active
  // person beneath them in the reporting tree. Walk through org-unit nodes as
  // well, since a department grouping can sit between a manager and a person.
  const visiblePersonIds = new Set<string>([profile.id]);
  if (canViewReportingSubtree) {
    const childrenByParent = new Map<string, InternalOrgRow[]>();
    organisationRows.forEach((row) => {
      if (!row.is_active || !row.parent_id) return;
      const children = childrenByParent.get(row.parent_id) ?? [];
      children.push(row);
      childrenByParent.set(row.parent_id, children);
    });

    const pendingParents = [profile.id];
    const visited = new Set<string>();
    while (pendingParents.length > 0) {
      const parentId = pendingParents.shift();
      if (!parentId || visited.has(parentId)) continue;
      visited.add(parentId);
      for (const child of childrenByParent.get(parentId) ?? []) {
        pendingParents.push(child.id);
        if (child.node_kind === "person") visiblePersonIds.add(child.id);
      }
    }
  }

  return requests.filter((request) => Boolean(request.personId && visiblePersonIds.has(request.personId)));
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
    fullDayHours: record.fullDayHours,
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
    evidenceDueDate: record.evidenceDueDate,
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

export function LeaveDemo({
  initialNavigation,
  isAdmin = false,
  currentPersonId,
  isNonRosterSystemAdmin = false,
  canViewEmployeeDirectory = false,
  canChangeEmployeeView = false,
  canViewSubscriptions = false,
  canManageSubscriptionCredentials = false,
  canManageSubscriptionCredentialGrants = false,
  canManageAnalyticsApi = false,
  canAccessOwnSubscriptions = false,
  canViewOwnTasks = false,
  canViewTeamCalendar = false,
  canViewSubscriptionReviewCalendar = false,
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
  /** Server-issued manager/System Admin capability for the safe directory projection. */
  canViewEmployeeDirectory?: boolean;
  canChangeEmployeeView?: boolean;
  /** System-derived System Admin access to the credential-free subscription register. */
  canViewSubscriptions?: boolean;
  /** Server-issued access to the encrypted subscription-service credential vault. */
  canManageSubscriptionCredentials?: boolean;
  /** System Admin-only capability to select named credential delegates. */
  canManageSubscriptionCredentialGrants?: boolean;
  /** System Admin-only capability to generate, rotate and revoke analytics keys. */
  canManageAnalyticsApi?: boolean;
  /** System-derived self-service access to the current employee's own subscriptions. */
  canAccessOwnSubscriptions?: boolean;
  /** An active employee can see the self-only Tasks tab even without manager scope. */
  canViewOwnTasks?: boolean;
  /** Server-issued active-employee/System Admin capability for Calendar. */
  canViewTeamCalendar?: boolean;
  /** Server-issued capability for an employee's own subscription review dates. */
  canViewSubscriptionReviewCalendar?: boolean;
  checkInResources?: CheckInResourceLinks;
}) {
  const directorySupabase = isSupabaseConfigured() ? createClient() : null;
  const isNonRosterSystemAdminWorkspace = isNonRosterSystemAdmin && !currentPersonId;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const initialView: AppView = initialNavigation?.view === "calendar" && !(canViewTeamCalendar || canViewSubscriptionReviewCalendar)
    ? "home"
    : initialNavigation?.view ?? "home";
  const [activeView, setActiveView] = useState<AppView>(initialView);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [leaveAttachments, setLeaveAttachments] = useState<LeaveAttachment[]>([]);
  const [calendarEntries, setCalendarEntries] = useState<LeaveRequest[]>([]);
  const [calendarBirthdays, setCalendarBirthdays] = useState<BirthdayCalendarEntry[]>([]);
  const [checkInCalendarEntries, setCheckInCalendarEntries] = useState<CheckInCalendarEntry[]>([]);
  const [subscriptionReviewCalendarEntries, setSubscriptionReviewCalendarEntries] = useState<SubscriptionReviewCalendarEntry[]>([]);
  const [payrollBalanceReminderEntries, setPayrollBalanceReminderEntries] = useState<PayrollBalanceReminderCalendarEntry[]>([]);
  const [canViewSubscriptionReviewCalendarForProfile, setCanViewSubscriptionReviewCalendarForProfile] = useState(canViewSubscriptionReviewCalendar);
  const [canViewPayrollBalanceReminderCalendar, setCanViewPayrollBalanceReminderCalendar] = useState(false);
  const [canImportPayrollBalances, setCanImportPayrollBalances] = useState(false);
  const [canReviewLeaveWorkspace, setCanReviewLeaveWorkspace] = useState(false);
  const [leavePriority, setLeavePriority] = useState<LeavePriorityWorkspace>();
  const [requestForPersonId, setRequestForPersonId] = useState("");
  const [formLeaveType, setFormLeaveType] = useState("");
  const [formStartDate, setFormStartDate] = useState(() => nextAvailableLeaveDate());
  const [formEndDate, setFormEndDate] = useState(() => nextAvailableLeaveDate());
  const [employmentType, setEmploymentType] = useState<LeaveWorkspaceData["employmentType"]>(null);
  const [hasPaidLeaveEntitlement, setHasPaidLeaveEntitlement] = useState(false);
  const [availableLeaveTypes, setAvailableLeaveTypes] = useState<LeaveWorkspaceData["availableLeaveTypes"]>([]);
  const [leaveWorkspaceUsesProfileScope, setLeaveWorkspaceUsesProfileScope] = useState(false);
  const [leaveDataLoading, setLeaveDataLoading] = useState(true);
  const [leaveDataError, setLeaveDataError] = useState("");
  const [workScheduleWorkspace, setWorkScheduleWorkspace] = useState<WorkScheduleWorkspace | null>(null);
  const [workScheduleLoading, setWorkScheduleLoading] = useState(true);
  const [workScheduleError, setWorkScheduleError] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState(initialNavigation?.requestId ?? "");
  const [mobileRequestDetailOpen, setMobileRequestDetailOpen] = useState(Boolean(initialNavigation?.requestId));
  const [leaveSection, setLeaveSection] = useState<LeaveSection>(initialNavigation?.section ?? "requests");
  const [statusFilter, setStatusFilter] = useState<"All" | RequestStatus>(initialNavigation?.requestId ? "All" : "Pending");
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
  // The preview loader is a stable no-argument callback for the employee
  // directory component. It carries only the selected preview id; the server
  // action rechecks the real System Admin capability and active target.
  const loadPreviewEmployeeDevices = useCallback(
    () => listItAssetsForEmployeePreview(previewPersonId),
    [previewPersonId],
  );
  const loadPreviewEmployeeSubscriptions = useCallback(
    () => listEmployeeSubscriptionsForPreview(previewPersonId),
    [previewPersonId],
  );
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [profilePickerQuery, setProfilePickerQuery] = useState("");
  const leaveRefreshSequence = useRef(0);
  const workScheduleRefreshSequence = useRef(0);
  const profileScopeEpoch = useRef(0);
  const workScheduleWorkspaceRef = useRef<WorkScheduleWorkspace | null>(null);
  const profilePickerDialogRef = useRef<HTMLElement>(null);
  const profilePickerSearchRef = useRef<HTMLInputElement>(null);
  const leaveRequestDialogRef = useRef<HTMLElement>(null);
  const leaveRequestInitialFocusRef = useRef<HTMLSelectElement>(null);
  const closeProfilePicker = useCallback(() => setProfilePickerOpen(false), []);
  const closeLeaveRequestForm = useCallback(() => setShowRequestForm(false), []);
  const closeMobileRequestDetail = useCallback(() => setMobileRequestDetailOpen(false), []);

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
    const requestEpoch = profileScopeEpoch.current;
    leaveRefreshSequence.current = requestSequence;
    setLeaveDataLoading(true);
    try {
      const data = await getLeaveWorkspaceData(previewPersonId || undefined);
      // A save, a safe Realtime invalidation and an initial load can overlap.
      // Only the newest role-scoped response may update calendar data.
      if (
        requestSequence !== leaveRefreshSequence.current
        || requestEpoch !== profileScopeEpoch.current
      ) return;
      setRequests(data.requests.map(toLeaveRequest));
      setLeavePriority(data.priority);
      setLeaveAttachments(data.attachments);
      setCalendarEntries(data.calendarEntries.map(toCalendarLeaveRequest));
      setCalendarBirthdays(data.birthdayEntries);
      setCheckInCalendarEntries(data.checkInEntries);
      setSubscriptionReviewCalendarEntries(data.subscriptionReviewEntries);
      setPayrollBalanceReminderEntries(data.payrollBalanceReminderEntries);
      setCanViewSubscriptionReviewCalendarForProfile(data.canViewSubscriptionReviewCalendar);
      setCanViewPayrollBalanceReminderCalendar(data.canViewPayrollBalanceReminderCalendar);
      setCanImportPayrollBalances(data.canImportPayrollBalances);
      setCanReviewLeaveWorkspace(data.canReviewLeave);
      setEmploymentType(data.employmentType);
      setHasPaidLeaveEntitlement(data.hasPaidLeaveEntitlement);
      setAvailableLeaveTypes(data.availableLeaveTypes);
      setLeaveWorkspaceUsesProfileScope(data.isProfilePreview);
      setLeaveDataError(data.warning ?? "");
    } catch {
      if (
        requestSequence !== leaveRefreshSequence.current
        || requestEpoch !== profileScopeEpoch.current
      ) return;
      // Do not leave a previously authorised calendar visible after a session,
      // access, or projection failure. The next successful role-scoped load
      // repopulates it.
      setRequests([]);
      setLeaveAttachments([]);
      setCalendarEntries([]);
      setCalendarBirthdays([]);
      setCheckInCalendarEntries([]);
      setSubscriptionReviewCalendarEntries([]);
      setPayrollBalanceReminderEntries([]);
      setCanViewSubscriptionReviewCalendarForProfile(false);
      setCanViewPayrollBalanceReminderCalendar(false);
      setCanImportPayrollBalances(false);
      setSelectedRequestId("");
      setCancellationRequestId(null);
      setCancellationFocusRequestId(null);
      setCancellationError("");
      setCanReviewLeaveWorkspace(false);
      setEmploymentType(null);
      setHasPaidLeaveEntitlement(false);
      setAvailableLeaveTypes([]);
      setLeavePriority(undefined);
      setLeaveWorkspaceUsesProfileScope(false);
      setLeaveDataError("Leave records could not be loaded. Refresh and try again.");
    } finally {
      if (
        requestSequence === leaveRefreshSequence.current
        && requestEpoch === profileScopeEpoch.current
      ) setLeaveDataLoading(false);
    }
  }, [previewPersonId]);

  const refreshWorkScheduleWorkspace = useCallback(async () => {
    const requestSequence = workScheduleRefreshSequence.current + 1;
    const requestEpoch = profileScopeEpoch.current;
    const hadWorkspace = workScheduleWorkspaceRef.current !== null;
    workScheduleRefreshSequence.current = requestSequence;
    if (!hadWorkspace) setWorkScheduleLoading(true);
    setWorkScheduleError("");

    try {
      const result = await loadEmployeeWorkScheduleWorkspace(previewPersonId || undefined);
      if (
        requestSequence !== workScheduleRefreshSequence.current
        || requestEpoch !== profileScopeEpoch.current
      ) return;

      if (!result.ok) {
        // Authorization, target and data-shape failures fail closed. A narrowly
        // classified transient upstream failure may retain the already scoped
        // workspace so background refresh cannot destroy an in-progress form.
        if (result.kind !== "transient") {
          workScheduleWorkspaceRef.current = null;
          setWorkScheduleWorkspace(null);
        }
        setWorkScheduleError(result.message);
        return;
      }

      workScheduleWorkspaceRef.current = result.workspace;
      setWorkScheduleWorkspace(result.workspace);
    } catch {
      if (
        requestSequence !== workScheduleRefreshSequence.current
        || requestEpoch !== profileScopeEpoch.current
      ) return;
      if (!hadWorkspace) {
        workScheduleWorkspaceRef.current = null;
        setWorkScheduleWorkspace(null);
      }
      setWorkScheduleError("Work schedule details could not be loaded. Refresh and try again.");
    } finally {
      if (
        requestSequence === workScheduleRefreshSequence.current
        && requestEpoch === profileScopeEpoch.current
      ) setWorkScheduleLoading(false);
    }
  }, [previewPersonId]);

  const submitWorkScheduleRequest = useCallback(async (
    workingWeekdays: EmployeeWorkingWeekday[],
    workingDayTimes: EmployeeWorkingDayTime[],
    reason: string,
  ): Promise<WorkScheduleMutationResult> => {
    const actionEpoch = profileScopeEpoch.current;
    const result = await requestEmployeeWorkScheduleChange({
      workingWeekdays,
      workingDayTimes,
      reason,
      previewPersonId: previewPersonId || undefined,
    });
    if (actionEpoch !== profileScopeEpoch.current) {
      return { ok: false, message: "The active profile changed. Open the schedule again." };
    }
    if (result.ok) void refreshWorkScheduleWorkspace();
    return result;
  }, [previewPersonId, refreshWorkScheduleWorkspace]);

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

  const reviewWorkScheduleRequest = useCallback(async (
    requestId: string,
    decision: "approved" | "declined",
    reason: string,
  ): Promise<WorkScheduleMutationResult> => {
    const actionEpoch = profileScopeEpoch.current;
    const result = await reviewEmployeeWorkScheduleChange({ requestId, decision, reason });
    if (actionEpoch !== profileScopeEpoch.current) {
      return { ok: false, message: "The active profile changed. Open the request again." };
    }
    if (result.ok) {
      void Promise.allSettled([
        refreshWorkScheduleWorkspace(),
        loadOrganisation(),
      ]);
    }
    return result;
  }, [loadOrganisation, refreshWorkScheduleWorkspace]);

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
          void refreshWorkScheduleWorkspace();
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
  }, [directorySupabase, loadOrganisation, loadSelfProfile, refreshLeaveWorkspace, refreshWorkScheduleWorkspace]);

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
    const timer = window.setTimeout(() => void refreshWorkScheduleWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshWorkScheduleWorkspace]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshWorkScheduleWorkspace();
    };
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshWorkScheduleWorkspace]);

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
          // Organisation structure is a reporting relationship, not an
          // authority grant. Keep every directory candidate fail-closed until
          // the server-projected capability for the active/previewed profile
          // is available below. In particular, a title containing “HR” or a
          // person with direct reports must never create UI authority.
          accessRole: "employee",
          roleLabel: row.position_title,
          team: row.company_key === "mam" ? "MAM" : "Equipsy",
          manager: managerFor(row),
          company: row.company_key,
        };
      });
  }, [organisationRows]);
  const canPreviewEmployeeAccess = isAdmin && canChangeEmployeeView && canManageEmployeeDirectory;
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
    if (organisationState !== "live" || !previewPersonId || selectedPreviewCandidate) return;
    const timer = window.setTimeout(() => {
      profileScopeEpoch.current += 1;
      workScheduleRefreshSequence.current += 1;
      leaveRefreshSequence.current += 1;
      setPreviewPersonId("");
      setSelectedEmployeeProfile(null);
      setSelectedEmployeeProfileErrorState(null);
      workScheduleWorkspaceRef.current = null;
      setWorkScheduleWorkspace(null);
      setWorkScheduleError("");
      setWorkScheduleLoading(true);
      setRequests([]);
      setLeaveAttachments([]);
      setCalendarEntries([]);
      setCalendarBirthdays([]);
      setCheckInCalendarEntries([]);
      setSubscriptionReviewCalendarEntries([]);
      setCanViewSubscriptionReviewCalendarForProfile(false);
      setCanReviewLeaveWorkspace(false);
      setEmploymentType(null);
      setHasPaidLeaveEntitlement(false);
      setAvailableLeaveTypes([]);
      setLeavePriority(undefined);
      setLeaveWorkspaceUsesProfileScope(false);
      setLeaveDataError("");
      setLeaveDataLoading(true);
      setActiveView("home");
      setToast("That employee profile is no longer available. Returned to Super Admin.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [organisationState, previewPersonId, selectedPreviewCandidate]);

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
  // These are server-projected capabilities for the real signed-in session,
  // not guesses from the employee's title or position in the organisation
  // tree. The visible People sections are selected from this role matrix.
  // `can_view_employee_directory` is the role capability, rather than a
  // data-dependent Check-in scope. A valid manager with no current reports
  // must still receive the manager workspace (with empty Check-ins/Tasks),
  // instead of being presented as an employee.
  const controlledAccessRole: AccessRole = isAdmin
    ? "hr"
    : canViewEmployeeDirectory
      ? "manager"
      : "employee";
  const adminProfile: Profile = { ...signedInProfile, accessRole: controlledAccessRole };
  // The selected role comes from a Super Admin-only server projection. Until
  // it arrives, Change profile fails closed as an employee presentation.
  // Reporting lines and job titles are never authority grants.
  const previewProfile: Profile | undefined = selectedPreviewCandidate
    ? {
        ...selectedPreviewCandidate,
        accessRole: selectedEmployeeProfile?.personId === selectedPreviewCandidate.id
          ? selectedEmployeeProfile.accessRole === "system_admin"
            ? "hr"
            : selectedEmployeeProfile.accessRole
          : "employee",
      }
    : undefined;
  const isPreviewingEmployeeAccess = Boolean(previewProfile);
  const activeProfile = previewProfile ?? adminProfile;
  // Real employees use the no-argument self-service action, which derives the
  // owner from auth.uid(). A Super Admin preview uses a separate read-only
  // target action that checks the Change profile capability and returns the
  // same safe DTO the selected employee would see.
  const hasSelfResourceDirectory = activeProfile.accessRole === "employee"
    || activeProfile.accessRole === "manager";
  const canLoadOwnDevices = !isPreviewingEmployeeAccess
    && hasSelfResourceDirectory
    && Boolean(currentPersonId && activeProfile.id === currentPersonId);
  const employeeDirectoryDeviceLoader = hasSelfResourceDirectory
    ? isPreviewingEmployeeAccess && selectedPreviewPersonId
      ? loadPreviewEmployeeDevices
      : canLoadOwnDevices
        ? listMyItAssets
        : undefined
    : undefined;
  const employeeDirectorySubscriptionLoader = hasSelfResourceDirectory
    ? isPreviewingEmployeeAccess && selectedPreviewPersonId
      ? canViewSubscriptions
        ? loadPreviewEmployeeSubscriptions
        : undefined
      : canAccessOwnSubscriptions
        ? listMySubscriptions
        : undefined
    : undefined;
  // Every active profile receives Calendar. The server projections scope an
  // employee preview to that person's leave and Check-ins plus birthdays;
  // browser role labels never decide which events are returned.
  const canViewTeamCalendarForActiveProfile = canViewTeamCalendar;
  const canViewPayrollBalanceReminderForActiveProfile = canViewPayrollBalanceReminderCalendar
    && !isPreviewingEmployeeAccess;
  const canViewActiveWorkspaceCalendar = canViewTeamCalendarForActiveProfile
    || canViewSubscriptionReviewCalendarForProfile
    || canViewPayrollBalanceReminderForActiveProfile;
  const calendarHidesTeamEvents = !canViewTeamCalendarForActiveProfile
    && (canViewSubscriptionReviewCalendarForProfile || canViewPayrollBalanceReminderForActiveProfile);
  // Change profile changes what the System Admin sees, not their real server
  // authority. Returning to their own profile restores the complete admin
  // workspace. Server Actions and RPCs still re-authorise the real session.
  const showHrWorkspace = isAdmin
    && canManageEmployeeDirectory
    && activeProfile.accessRole === "hr";
  const hasManagerPeopleWorkspace = canViewEmployeeDirectory
    || (isPreviewingEmployeeAccess && isAdmin);
  const showManagerDirectory = activeProfile.accessRole === "manager"
    && hasManagerPeopleWorkspace;
  const showManagerCheckIns = activeProfile.accessRole === "manager"
    && hasManagerPeopleWorkspace;
  const showManagerTasks = activeProfile.accessRole === "manager"
    && hasManagerPeopleWorkspace;
  // A System Admin keeps their real subscription-management authority while
  // using Change profile. Explicit vault delegates receive a deliberately
  // smaller credential-only surface instead of the operational register.
  const showSubscriptionRegister = canViewSubscriptions || canManageSubscriptionCredentials;
  const previewScopedManagerPersonId = isPreviewingEmployeeAccess
    && activeProfile.accessRole === "manager"
    ? previewProfile?.id
    : undefined;
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
  const expectedWorkSchedulePersonId = selectedPreviewPersonId || currentPersonId || null;
  const visibleWorkScheduleWorkspace = workScheduleWorkspace
    && workScheduleWorkspace.isProfilePreview === Boolean(selectedPreviewPersonId)
    && workScheduleWorkspace.activePersonId === expectedWorkSchedulePersonId
    ? workScheduleWorkspace
    : null;
  // The capability is issued by the server-side leave policy. Change profile
  // only narrows the displayed employee; it never changes the Super Admin's
  // reviewer authority.
  const canReviewLeave = canReviewLeaveWorkspace;
  // Super Admin keeps full operational access while Change Profile is active.
  // The selected target is passed only to the guarded Server Action; auth and
  // audit authority remain with the real Super Admin account.
  const canApplyForLeave = availableLeaveTypes.length > 0
    && (!isNonRosterSystemAdminWorkspace || isPreviewingEmployeeAccess);
  const teamRequestPeople = leavePriority?.people.filter((person) => person.canSubmit) ?? [];
  const requestedTeamMember = requestForPersonId
    ? teamRequestPeople.find((person) => person.personId === requestForPersonId)
    : undefined;
  const leaveRequestPersonName = requestedTeamMember?.name ?? activeProfile.name;
  const leaveRequestPersonInitials = requestedTeamMember
    ? initialsForName(requestedTeamMember.name)
    : activeProfile.initials;
  // The server-projected per-request capability remains the source of truth.
  // This only prevents a Change profile or non-roster platform workspace from
  // presenting an impossible cancellation control.
  const canCancelOwnLeave = !isNonRosterSystemAdminWorkspace
    || isPreviewingEmployeeAccess;
  // Change Profile's leave data is already projected by the guarded server
  // action. Do not narrow it again in the browser: that used to hide a
  // manager's team queue when testing Luke or Todd from Super Admin.
  const visibleRequests = isPreviewingEmployeeAccess
    ? leaveWorkspaceUsesProfileScope
      ? requests
      : getEmployeePreviewRequests(requests, activeProfile, organisationRows, false)
    : requests;
  const calendarRequests = isPreviewingEmployeeAccess
    ? leaveWorkspaceUsesProfileScope
      ? calendarEntries
      : getEmployeePreviewRequests(calendarEntries, activeProfile, organisationRows, false)
    : calendarEntries;
  // Check-in Calendar rows are owner-scoped by the server in employee and
  // Change Profile modes; System Admin's own workspace retains global scope.
  const calendarCheckIns = checkInCalendarEntries;
  const calendarSubscriptionReviews = subscriptionReviewCalendarEntries;
  const calendarPayrollBalanceReminders = isPreviewingEmployeeAccess ? [] : payrollBalanceReminderEntries;
  const approvalQueue = canReviewLeave
    ? visibleRequests.filter((request) => request.canDecide)
    : [];
  const canAccessBalance = canImportPayrollBalances
    || (!isPreviewingEmployeeAccess && leavePriority?.canManageBalances === true);
  const myRequests = requests.filter((request) => request.personId === activeProfile.id);
  const filteredRequests = visibleRequests.filter((request) => {
    return statusFilter === "All" || request.status === statusFilter;
  });
  const selectedRegisterRequest = selectedRequestId
    ? filteredRequests.find((request) => request.id === selectedRequestId)
    : filteredRequests[0];
  const selectedApprovalRequest = selectedRequestId
    ? approvalQueue.find((request) => request.id === selectedRequestId)
    : approvalQueue[0];
  const authorisedLeaveSection = resolveAuthorisedLeaveSection(
    leaveSection,
    canReviewLeave,
    canAccessBalance,
  );
  const selectedRequest = authorisedLeaveSection === "approvals" ? selectedApprovalRequest : selectedRegisterRequest;
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
    const nextProfileId = nextProfile?.id ?? "";

    if (nextProfileId === previewPersonId) {
      setProfilePickerOpen(false);
      setProfilePickerQuery("");
      return;
    }

    profileScopeEpoch.current += 1;
    leaveRefreshSequence.current += 1;
    workScheduleRefreshSequence.current += 1;
    workScheduleWorkspaceRef.current = null;
    setWorkScheduleWorkspace(null);
    setWorkScheduleError("");
    setWorkScheduleLoading(true);
    setRequests([]);
    setLeaveAttachments([]);
    setCalendarEntries([]);
    setCalendarBirthdays([]);
    setCheckInCalendarEntries([]);
    setSubscriptionReviewCalendarEntries([]);
    setCanViewSubscriptionReviewCalendarForProfile(false);
    setCanViewPayrollBalanceReminderCalendar(false);
    setCanImportPayrollBalances(false);
    setCanReviewLeaveWorkspace(false);
    setLeaveWorkspaceUsesProfileScope(false);
    setLeaveDataError("");
    setLeaveDataLoading(true);
    setPreviewPersonId(nextProfileId);
    setProfilePickerOpen(false);
    setProfilePickerQuery("");
    setSelectedEmployeeProfile(null);
    setSelectedEmployeeProfileErrorState(null);
    setShowRequestForm(false);
    setFormError("");
    setEmploymentType(null);
    setHasPaidLeaveEntitlement(false);
    setAvailableLeaveTypes([]);
      setLeavePriority(undefined);
    setManagerNote("");
    setCancellationRequestId(null);
    setCancellationFocusRequestId(null);
    setCancellationError("");
    setCancelledRequestId(null);
    setSelectedRequestId("");
    setLeaveSection("requests");
    setActiveView("home");

    if (nextProfile) {
      announce(`Viewing ${nextProfile.name}'s profile. System Admin permissions remain active.`);
    } else {
      announce("Returned to Super Admin.");
    }
  }

  function chooseLeaveSection(section: LeaveSection, requestedId?: string) {
    if (section === "approvals" && !canReviewLeave) return;
    if (section === "balance" && !canAccessBalance) return;
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
    if (view === "calendar" && !canViewActiveWorkspaceCalendar) {
      setActiveView("home");
      scrollPageToTop();
      return;
    }
    if (view === "leave") {
      if (!section) changeLeaveStatusFilter("Pending");
      chooseLeaveSection(section ?? "requests");
    }
    else {
      setMobileRequestDetailOpen(false);
      setCancellationRequestId(null);
      setCancellationFocusRequestId(null);
      setCancellationError("");
    }
    setActiveView(view);
    scrollPageToTop();
  }

  function changeLeaveStatusFilter(filter: "All" | RequestStatus) {
    setStatusFilter(filter);
    setSelectedRequestId("");
    setMobileRequestDetailOpen(false);
    setCancellationRequestId(null);
    setCancellationFocusRequestId(null);
    setCancellationError("");
  }

  function openLeaveRequestForm() {
    openTeamLeaveRequestForm("");
  }

  function changeLeaveRequestPerson(personId: string) {
    const target = personId
      ? teamRequestPeople.find((person) => person.personId === personId)
      : undefined;
    if ((personId && !target) || (!personId && !canApplyForLeave)) return;
    setRequestForPersonId(personId);
    setFormLeaveType(
      target
        ? target.paidLeave ? "Annual leave" : "Unpaid leave"
        : availableLeaveTypes[0]?.value ?? "Unpaid leave",
    );
    setFormError("");
  }

  function openTeamLeaveRequestForm(personId: string) {
    const target = personId ? teamRequestPeople.find((person) => person.personId === personId) : undefined;
    if (isMutating || (personId ? !target : !canApplyForLeave)) return;
    changeLeaveRequestPerson(personId);
    const initialDate = nextAvailableLeaveDate();
    setFormStartDate(initialDate);
    setFormEndDate(initialDate);
    setShowRequestForm(true);
  }

  function selectRequest(id: string, section: LeaveSection = "requests") {
    // Explicit record links must remain reachable outside the default Pending filter.
    if (section === "requests" && !filteredRequests.some((request) => request.id === id)) setStatusFilter("All");
    setSelectedRequestId(id);
    setMobileRequestDetailOpen(
      typeof window !== "undefined" && window.matchMedia("(max-width: 680px)").matches,
    );
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
    if (isMutating || (!requestForPersonId && !isPreviewingEmployeeAccess && isNonRosterSystemAdminWorkspace)) return;
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
      const next = requestForPersonId
        ? await submitLeaveRequestForSelectedEmployee(requestForPersonId, requestInput)
        : isPreviewingEmployeeAccess && previewProfile
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

  async function deleteSupportingFile(attachmentId: string) {
    if (isMutating) return;
    const attachment = leaveAttachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment?.canDelete) {
      announce("Only the person who uploaded this supporting file can delete it.");
      return;
    }

    setIsMutating(true);
    try {
      await deleteLeaveRequestAttachment({ attachmentId });
      await refreshLeaveWorkspace();
      announce("Supporting file deleted.");
    } catch (error) {
      announce(error instanceof Error
        ? error.message
        : "The supporting file could not be deleted. Refresh and try again.");
    } finally {
      setIsMutating(false);
    }
  }

  async function decideRequest(status: LeaveDecision) {
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
      setSelectedRequestId(status === BALANCE_PENDING_STATUS ? decided.id : nextApproval?.id ?? decided.id);
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
      || selectedRequest.canCancel !== true
      || !canCancelOwnLeave
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
      || selectedRequest.canCancel !== true
      || !canCancelOwnLeave
      || cancellationRequestId !== requestId
      || isMutating
    ) return;

    setIsMutating(true);
    setCancellationError("");
    try {
      const cancelled = isPreviewingEmployeeAccess && previewProfile
        ? await cancelSelectedEmployeeLeaveRequest(previewProfile.id, { requestId })
        : await cancelMyLeaveRequest({ requestId });
      if (!cancelled.ok) {
        setCancellationError(cancelled.message);
        return;
      }
      setCancellationRequestId(null);
      setCancellationFocusRequestId(null);
      setCancelledRequestId(cancelled.id);
      await refreshLeaveWorkspace();
      setSelectedRequestId(requestId);
      announce(isPreviewingEmployeeAccess
        ? "The selected employee's leave was cancelled. The record and decision history are kept."
        : "Your leave was cancelled. The record and decision history are kept.");
    } catch (error) {
      setCancellationError(error instanceof Error ? error.message : "The leave could not be cancelled. Refresh and try again.");
    } finally {
      setIsMutating(false);
    }
  }

  const navItems = [
    { id: "home" as AppView, label: "Home", icon: LayoutDashboard },
    { id: "leave" as AppView, label: "Leave", icon: ClipboardList, badge: canReviewLeave ? approvalQueue.length : undefined },
    ...(canViewActiveWorkspaceCalendar ? [{ id: "calendar" as AppView, label: "Calendar", icon: CalendarDays }] : []),
    { id: "people" as AppView, label: "People", icon: UsersRound },
  ];
  const navCountStyle = { "--nav-count": navItems.length } as CSSProperties;

  return (
    <div className={`${styles.shell} ${activeView === "calendar" ? styles.calendarShell : ""}`} data-company={activeProfile.company}>
      <a className={styles.skipLink} href="#main-content">Skip to workspace</a>
      <aside className={styles.sidebar} aria-label="People Hub navigation">
        <div className={styles.brandRow}><BrandMark /></div>
        <span className={styles.navHeading}>Workspace</span>
        <nav className={styles.nav} style={navCountStyle}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button aria-current={activeView === item.id ? "page" : undefined} className={`${styles.navItem} ${activeView === item.id ? styles.navItemActive : ""}`} type="button" onClick={() => navigate(item.id)} key={item.id}>
                <span className={styles.navIcon}><Icon size={18} strokeWidth={1.8} /></span><b>{item.label}</b>{item.badge ? <i>{item.badge}</i> : null}
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
            <div className={styles.viewSwitcherHeading}>
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
            </div>
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
            {profilePickerOpen ? <ModalBackdrop className={styles.profilePickerBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProfilePicker(); }}>
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
        </ModalBackdrop> : null}
      </aside>

      <div className={`${styles.workspace} ${activeView === "calendar" ? styles.calendarWorkspace : ""}`}>
        <header className={styles.topbar}>
          <div className={styles.topbarHeading}>
            <span>{activeProfile.company === "equipsy" ? "Equipsy" : "MAM"} workspace</span>
            <h1 className={styles.pageTitle}>{navItems.find((item) => item.id === activeView)?.label}</h1>
          </div>
          <div className={styles.mobileBrand}><BrandMark compact /></div>
          <div className={styles.topActions}>
            {organisationState !== "live" ? (
              <span className={styles.demoStatus} data-state={organisationState} role="status">
                <i />
                {organisationState === "connecting" ? "Connecting" : "Directory issue"}
              </span>
            ) : null}
            {directorySupabase ? <button className={styles.signOutButton} type="button" onClick={() => void handleSignOut()} disabled={isSigningOut} aria-label={isSigningOut ? "Signing out" : "Sign out"} title="Sign out"><LogOut size={17} aria-hidden="true" /></button> : null}
            {isPreviewingEmployeeAccess ? <button className={styles.mobileReturnButton} type="button" onClick={() => changeEmployeeAccessPreview("")} aria-label="Return to Super Admin" title="Return to Super Admin"><RotateCcw size={17} aria-hidden="true" /></button> : null}
            {canPreviewEmployeeAccess ? <button className={styles.mobileProfileTrigger} type="button" onClick={() => { setProfilePickerQuery(""); setProfilePickerOpen(true); }} aria-label={`Change profile. ${previewProfile ? `Viewing ${previewProfile.name}` : "Super Admin"}`} title="Change profile"><span>{previewProfile?.initials ?? "SA"}</span><ChevronDown size={14} aria-hidden="true" /></button> : null}
            {isNonRosterAdminHrWorkspace ? (
              <span className={styles.demoStatus} title="This platform administrator is not an employee profile.">
                <ShieldCheck aria-hidden="true" size={15} /> Admin
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

        <main className={`${styles.main} ${activeView === "calendar" ? styles.calendarMain : ""}`} id="main-content">
          {leaveDataError && activeView !== "people" ? <div className={styles.loadErrorAction} role="alert"><span>{leaveDataError}</span><button type="button" onClick={() => void refreshLeaveWorkspace()} disabled={leaveDataLoading}>{leaveDataLoading ? "Retrying…" : "Retry"}</button></div> : null}
          {selfProfileError && !isPreviewingEmployeeAccess && !isNonRosterSystemAdminWorkspace ? <div className={styles.loadErrorAction} role="alert"><span>{selfProfileError}</span><button type="button" onClick={() => void loadSelfProfile()} disabled={selfProfileLoading}>{selfProfileLoading ? "Retrying…" : "Retry profile"}</button></div> : null}
          {selectedEmployeeProfileError && isPreviewingEmployeeAccess ? <div className={styles.loadErrorAction} role="alert"><span>{selectedEmployeeProfileError}</span><button type="button" onClick={() => setSelectedEmployeeProfileReloadKey((current) => current + 1)}>Retry profile</button></div> : null}
          {organisationAccessError && activeView === "people" ? <div className={styles.loadErrorAction} role="alert"><span>{organisationAccessError}</span><button type="button" onClick={() => void loadOrganisation()}>Retry permissions</button></div> : null}
          {activeView === "home" ? <HomeView
            profile={activeProfile}
            requests={calendarRequests}
            myRequests={myRequests}
            pending={approvalQueue}
            canReview={canReviewLeave}
            onNavigate={navigate}
            onSelect={selectRequest}
            isNonRosterSystemAdmin={isNonRosterAdminHrWorkspace}
            workSchedule={<WorkScheduleHome
              workspace={visibleWorkScheduleWorkspace}
              loading={workScheduleLoading}
              error={workScheduleError}
              onRefresh={refreshWorkScheduleWorkspace}
              onRequest={submitWorkScheduleRequest}
              onReview={reviewWorkScheduleRequest}
            />}
          /> : null}
          {activeView === "leave" ? <LeaveWorkspaceLoadBoundary loading={leaveDataLoading}>
            <LeaveView leavePriority={leavePriority} onBalancesSaved={refreshLeaveWorkspace} profile={activeProfile} section={authorisedLeaveSection} requests={filteredRequests} allRequests={visibleRequests} selected={selectedRequest} filter={statusFilter} pending={approvalQueue} canReview={canReviewLeave} canAccessBalance={canAccessBalance} balanceContent={<><PayrollBalanceImporter onSaved={refreshLeaveWorkspace} /><LeavePriorityControls key={previewPersonId || "self"} previewPersonId={previewPersonId} workspace={leavePriority} busy={isMutating} onRequest={openTeamLeaveRequestForm} onSaved={refreshLeaveWorkspace} /></>} selectedId={selectedRequestId} note={managerNote} calendarRequests={calendarRequests} calendarCheckIns={calendarCheckIns} attachmentsByRequestId={attachmentsByRequestId} busy={isMutating} readOnly={false} hidePrivateDetails={false} canApplyForLeave={canApplyForLeave} canCancelOwnLeave={canCancelOwnLeave} mobileDetailOpen={mobileRequestDetailOpen} cancellationRequestId={cancellationRequestId} cancellationError={cancellationError} cancelledRequestId={cancelledRequestId} onRequestLeave={openLeaveRequestForm} onFilter={changeLeaveStatusFilter} onSection={chooseLeaveSection} onNote={setManagerNote} onSelect={selectRequest} onCloseMobileDetail={closeMobileRequestDetail} onDecision={decideRequest} onAddSupportingFiles={addSupportingFiles} onDeleteSupportingFile={deleteSupportingFile} onStartCancellation={startLeaveCancellation} onDismissCancellation={dismissLeaveCancellation} onConfirmCancellation={confirmLeaveCancellation} />
          </LeaveWorkspaceLoadBoundary> : null}
          {activeView === "calendar" && canViewActiveWorkspaceCalendar ? <TeamCalendar
            birthdays={calendarHidesTeamEvents ? [] : calendarBirthdays}
            checkIns={calendarHidesTeamEvents ? [] : calendarCheckIns}
            requests={calendarHidesTeamEvents ? [] : calendarRequests}
            subscriptionReviews={calendarSubscriptionReviews}
            payrollBalanceReminders={calendarPayrollBalanceReminders}
            showSubscriptionReviews={canViewSubscriptionReviewCalendarForProfile}
            showPayrollBalanceReminders={canViewPayrollBalanceReminderForActiveProfile}
            reviewOnly={calendarHidesTeamEvents}
            loading={leaveDataLoading}
          /> : null}
          <div hidden={activeView !== "people"}>
            <PeopleOperationsDemo
              key={`${activeProfile.accessRole}:${isPreviewingEmployeeAccess ? activeProfile.id : "signed-in"}`}
              activeProfile={activeProfile}
              organisationProfiles={organisationPeople}
              canEditOrganisation={canEditOrganisation && showHrWorkspace}
              canArrangeOrganisation={canEditOrganisation && showHrWorkspace}
              showProfile={false}
              showTasks={canViewOwnTasks || showHrWorkspace || showManagerTasks || (isPreviewingEmployeeAccess && activeProfile.accessRole === "employee")}
              isAccessPreview={isPreviewingEmployeeAccess}
              legacyCheckInFormsUrl={checkInResources?.legacyFormsFolderUrl}
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
              /> : showManagerDirectory ? <ManagerEmployeeDirectory
                previewManagerPersonId={previewScopedManagerPersonId}
                managerPersonId={previewScopedManagerPersonId ?? currentPersonId}
                onLoadMyDevices={employeeDirectoryDeviceLoader}
                onLoadMySubscriptions={employeeDirectorySubscriptionLoader}
                onRecordsChanged={async () => {
                  // Refresh public organisation data after the manager-safe
                  // record mutation. The manager directory itself never
                  // receives HR-private detail rows.
                  await loadOrganisation();
                }}
                refreshKey={employeeDirectoryRefreshKey}
              /> : activeProfile.accessRole === "employee" ? <EmployeeTeamDirectory
                key={activeProfile.id}
                people={organisationPeople}
                currentPersonId={activeProfile.id}
                onRequestWorkEmail={getOrganisationPersonWorkEmail}
                onLoadMyDevices={employeeDirectoryDeviceLoader}
                onLoadMySubscriptions={employeeDirectorySubscriptionLoader}
              /> : undefined}
              renderCheckInRegister={showHrWorkspace
                ? <CheckInRegister
                    onRecordsChanged={() => void refreshLeaveWorkspace()}
                    resources={checkInResources}
                  />
                : showManagerCheckIns
                  ? <CheckInWorkspace
                      previewPersonId={previewScopedManagerPersonId}
                      readOnly={false}
                      onRecordsChanged={() => void refreshLeaveWorkspace()}
                      resources={checkInResources}
                    />
                  : undefined}
              renderCheckInTasks={showHrWorkspace || showManagerTasks || canViewOwnTasks || (isPreviewingEmployeeAccess && activeProfile.accessRole === "employee")
                ? (toolbarAction) => <CheckInTasks
                    previewPersonId={previewScopedManagerPersonId}
                    readOnly={false}
                    toolbarAction={toolbarAction}
                    showCheckInTasks={showHrWorkspace || showManagerTasks}
                    scheduleContent={<WorkScheduleTasks
                      workspace={visibleWorkScheduleWorkspace}
                      loading={workScheduleLoading}
                      error={workScheduleError}
                      onRefresh={refreshWorkScheduleWorkspace}
                      onRequest={submitWorkScheduleRequest}
                      onReview={reviewWorkScheduleRequest}
                    />}
                  />
                : undefined}
              renderAccounts={showHrWorkspace ? accountsLoading
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
              renderAssetRegister={showHrWorkspace && !isPreviewingEmployeeAccess
                ? <AssetRegister />
                : undefined}
              renderSubscriptionRegister={showSubscriptionRegister
                ? canViewSubscriptions
                  ? <SubscriptionRegister
                      readOnly={!isAdmin}
                      canManageCredentials={canManageSubscriptionCredentials}
                      canManageCredentialGrants={canManageSubscriptionCredentialGrants}
                      onRecordsChanged={() => void refreshLeaveWorkspace()}
                    />
                  : <SubscriptionCredentialVault
                      canManageCredentialGrants={canManageSubscriptionCredentialGrants}
                    />
                : undefined}
              renderAnalyticsApiManagement={canManageAnalyticsApi && !isPreviewingEmployeeAccess
                ? <AnalyticsApiManagement />
                : undefined}
            />
          </div>
        </main>
      </div>

      {showRequestForm ? (
        <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeLeaveRequestForm()}>
          <section className={styles.modal} ref={leaveRequestDialogRef} role="dialog" aria-modal="true" aria-labelledby="new-request-title" tabIndex={-1}>
            <header><div><h2 id="new-request-title">Request leave</h2></div><button type="button" onClick={closeLeaveRequestForm} aria-label="Close request form"><X size={19} /></button></header>
            <div className={styles.formPerson}>
              <span className={styles.avatarOrange}>{leaveRequestPersonInitials}</span>
              <span className={styles.formPersonCopy}>
                <strong>{leaveRequestPersonName}</strong>
                <small>{requestForPersonId ? "On behalf of your team member" : activeProfile.team}</small>
              </span>
              {teamRequestPeople.length ? (
                <label className={styles.requestPersonPicker}>
                  <UsersRound aria-hidden="true" size={15} />
                  <span className={styles.srOnly}>Request leave for</span>
                  <select
                    aria-label="Request leave for"
                    disabled={isMutating}
                    onChange={(event) => changeLeaveRequestPerson(event.currentTarget.value)}
                    title="Change request person"
                    value={requestForPersonId}
                  >
                    {canApplyForLeave ? <option value="">Myself</option> : null}
                    {teamRequestPeople.map((person) => (
                      <option key={person.personId} value={person.personId}>{person.name}</option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden="true" size={14} />
                </label>
              ) : null}
            </div>
            {formLeaveType === "Annual leave" ? <LeaveRequestBalance workspace={leavePriority} personId={requestForPersonId || activeProfile.id} self={!requestForPersonId} /> : null}
            <form className={styles.form} onSubmit={submitRequest} onChange={() => setFormError("")}>
              <label><span>Leave type</span><select ref={leaveRequestInitialFocusRef} name="leaveType" value={formLeaveType} onChange={(event) => setFormLeaveType(event.target.value)} required>{(requestedTeamMember ? (requestedTeamMember.paidLeave ? ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave"] : ["Unpaid leave"]).map((value) => ({ value, label: value })) : availableLeaveTypes).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
              {!requestForPersonId && !hasPaidLeaveEntitlement ? <p className={styles.leavePolicyNote} role="note">
                {employmentType === "abn" ? "ABN" : employmentType === "casual" ? "Casual" : "Unclassified"} employees can record Unpaid leave only.
              </p> : null}
              <div className={styles.formRow}><label><span>Start date</span><input name="startDate" type="date" value={formStartDate} onChange={(event) => { const nextDate = event.target.value; setFormStartDate(nextDate); setFormEndDate(nextDate); }} required /></label><label><span>End date</span><input name="endDate" type="date" min={formStartDate} value={formEndDate} onChange={(event) => setFormEndDate(event.target.value)} required /></label></div>
              {formLeaveType === "Sick leave" ? <SickEvidenceNotice dueDate={sickEvidenceDeadline(formEndDate)} hasEvidence={false} /> : null}
              <details className={styles.timeRange}><summary>Part-day leave</summary><div className={styles.formRow}><label><span>Starts</span><select name="startTime" defaultValue=""><option value="">Select time</option>{START_TIME_OPTIONS.map((option) => <option value={option.value} key={`start-${option.value}`}>{option.label}</option>)}</select></label><label><span>Ends</span><select name="endTime" defaultValue=""><option value="">Select time</option>{END_TIME_OPTIONS.map((option) => <option value={option.value} key={`end-${option.value}`}>{option.label}</option>)}</select></label></div><p>First and last day only.</p></details>
              <details className={styles.requestExtras}><summary>Note & files</summary>
              <div className={styles.requestExtrasContent}>
                <label><span>Note</span><textarea name="employeeNote" rows={3} /></label>
                <label className={styles.attachmentField}>
                  <span>Supporting files <small>Optional</small></span>
                  <input className={styles.fileInput} name="attachments" type="file" accept={LEAVE_ATTACHMENT_ACCEPT} multiple disabled={isMutating} />
                  <small>PDF or image · up to 10 files, 5 MB each.</small>
                </label>
                <small className={styles.privacyNote}>Visible to your approver and HR.</small>
              </div>
              </details>
              {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
              <footer><button className={styles.secondaryButton} type="button" onClick={closeLeaveRequestForm} disabled={isMutating}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={isMutating}>{isMutating ? "Saving…" : "Send request"}</button></footer>
            </form>
          </section>
        </ModalBackdrop>
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
    <aside className={styles.sidebar} aria-label="People Hub navigation">
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
  return <span className={`${styles.status} ${status === BALANCE_PENDING_STATUS ? styles.statusBalancePending : styles[`status${status}`]}`}><i />{status === BALANCE_PENDING_STATUS ? "Waiting for balance" : status}</span>;
}

function HomeView({ profile, requests, myRequests, pending, canReview, onNavigate, onSelect, isNonRosterSystemAdmin = false, workSchedule }: { profile: Profile; requests: LeaveRequest[]; myRequests: LeaveRequest[]; pending: LeaveRequest[]; canReview: boolean; onNavigate: (view: AppView, section?: LeaveSection) => void; onSelect: (id: string, section?: LeaveSection) => void; isNonRosterSystemAdmin?: boolean; workSchedule?: ReactNode }) {
  if (isNonRosterSystemAdmin) {
    return (
      <div className={styles.dashboard}>
        {workSchedule}
        <section className={styles.panel}>
          <div className={styles.emptyState}>
            <ShieldCheck size={24} />
            <strong>Choose a profile or open People</strong>
            {canReview && pending.length ? <button className={styles.primaryButton} type="button" onClick={() => onNavigate("leave", "approvals")}>Review leave ({pending.length})</button> : null}
            <button className={styles.secondaryButton} type="button" onClick={() => onNavigate("people")}>Open People</button>
          </div>
        </section>
      </div>
    );
  }

  const activeOwnRequests = myRequests.filter((request) => request.status !== "Cancelled");
  const pendingOwnRequests = activeOwnRequests.filter((request) => request.status === "Pending" || request.status === BALANCE_PENDING_STATUS);
  const homeOwnRequests = pendingOwnRequests.length ? pendingOwnRequests : activeOwnRequests.slice(0, 1);
  const ownLeaveCards = homeOwnRequests.map((request) => (
    <button key={request.id} className={styles.nextLeaveSimple} type="button" onClick={() => onSelect(request.id, "requests")}>
      <span><StatusPill status={request.status} /><strong>{request.leaveType}</strong><small>{request.dateLabel} · {formatDurationWithTime(request)}</small></span>
      <ChevronRight size={17} />
    </button>
  ));
  const attentionRequests = canReview ? pending : requests.filter((request) => request.status === "Pending" && request.personId !== profile.id);
  const attentionTitle = canReview ? "Needs review" : "Pending leave";
  const recordSection: LeaveSection = canReview ? "approvals" : "requests";
  if (!canReview) {
    return (
      <div className={styles.dashboard}>
        {workSchedule}
        <section className={`${styles.panel} ${styles.myLeavePanel} ${styles.personalLeavePanel}`}>
          <PanelHeader title="My leave" action="Open my leave" onAction={() => onNavigate("leave")} />
          {ownLeaveCards.length ? ownLeaveCards : <div className={styles.emptyState}><CalendarDays size={24} /><strong>No leave requests</strong></div>}
        </section>
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      {workSchedule}
      <div className={styles.homeGrid}>
        <section className={`${styles.panel} ${styles.attentionPanel}`}>
          <PanelHeader title={attentionTitle} action="Open requests" onAction={() => onNavigate("leave", recordSection)} />
          <div className={styles.recordList}>
            {attentionRequests.slice(0, 3).map((request) => <button type="button" onClick={() => onSelect(request.id, recordSection)} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small></span><span className={styles.dayCount}>{request.hours ?? request.days}<small>{request.hours ? (request.hours === 1 ? "hour" : "hours") : request.days === 1 ? "day" : "days"}</small></span><ChevronRight size={16} /></button>)}
            {!attentionRequests.length ? <div className={styles.emptyState}><CheckCircle2 size={24} /><strong>Nothing needs action</strong></div> : null}
          </div>
        </section>

        <section className={`${styles.panel} ${styles.myLeavePanel}`}>
          <PanelHeader title="My leave" action="Open my leave" onAction={() => onNavigate("leave")} />
          {ownLeaveCards.length ? ownLeaveCards : <div className={styles.emptyState}><CalendarDays size={24} /><strong>No leave requests yet</strong></div>}
        </section>
      </div>
    </div>
  );
}

function PanelHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <header className={styles.panelHeader}><h2>{title}</h2>{action && onAction ? <button type="button" onClick={onAction} aria-label={action} title={action}><ChevronRight size={18} aria-hidden="true" /></button> : null}</header>;
}

function LeaveWorkspaceLoadBoundary({ loading, children }: { loading: boolean; children: ReactNode }) {
  return loading ? <LeaveLoadingState /> : children;
}

function LeaveLoadingState() {
  return (
    <section className={`${styles.panel} ${styles.emptyState}`} role="status" aria-live="polite" aria-busy="true">
      <Clock3 size={24} aria-hidden="true" />
      <strong>Loading leave</strong>
      <span>Fetching your authorised leave workspace…</span>
    </section>
  );
}

function LeaveView({ leavePriority, onBalancesSaved, profile, section, requests, allRequests, selected, filter, pending, canReview, canAccessBalance, balanceContent, selectedId, note, calendarRequests, calendarCheckIns, attachmentsByRequestId, busy, readOnly, hidePrivateDetails, canApplyForLeave, canCancelOwnLeave, mobileDetailOpen, cancellationRequestId, cancellationError, cancelledRequestId, onRequestLeave, onFilter, onSection, onNote, onSelect, onCloseMobileDetail, onDecision, onAddSupportingFiles, onDeleteSupportingFile, onStartCancellation, onDismissCancellation, onConfirmCancellation }: { leavePriority?: LeavePriorityWorkspace; onBalancesSaved: () => Promise<void>; profile: Profile; section: LeaveSection; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected?: LeaveRequest; filter: "All" | RequestStatus; pending: LeaveRequest[]; canReview: boolean; canAccessBalance: boolean; balanceContent: ReactNode; selectedId: string; note: string; calendarRequests: LeaveRequest[]; calendarCheckIns: CheckInCalendarEntry[]; attachmentsByRequestId: Map<string, LeaveAttachment[]>; busy: boolean; readOnly: boolean; hidePrivateDetails: boolean; canApplyForLeave: boolean; canCancelOwnLeave: boolean; mobileDetailOpen: boolean; cancellationRequestId: string | null; cancellationError: string; cancelledRequestId: string | null; onRequestLeave: () => void; onFilter: (filter: "All" | RequestStatus) => void; onSection: (section: LeaveSection) => void; onNote: (note: string) => void; onSelect: (id: string, section?: LeaveSection) => void; onCloseMobileDetail: () => void; onDecision: (status: LeaveDecision) => void; onAddSupportingFiles: (requestId: string, files: File[]) => Promise<void>; onDeleteSupportingFile: (attachmentId: string) => Promise<void>; onStartCancellation: (requestId: string) => void; onDismissCancellation: () => void; onConfirmCancellation: (requestId: string) => void }) {
  const applyAction = canApplyForLeave ? <button className={`${styles.primaryButton} ${styles.applyForLeaveButton}`} type="button" onClick={onRequestLeave} disabled={busy} aria-haspopup="dialog" aria-label="Apply for leave" title="Apply for leave"><Plus aria-hidden="true" size={17} /><span className={styles.applyFullLabel}>Apply for leave</span><span className={styles.applyCompactLabel}>Apply</span></button> : null;
  return (
    <section className={styles.leaveDesk}>
      <div className={styles.leaveHeader}>
      {canReview || canAccessBalance ? (
        <div className={styles.leaveSwitch} aria-label="Leave workspace">
          <button className={section === "requests" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "requests"} ref={section === "requests" ? revealSelectedLeaveTab : undefined} onClick={() => onSection("requests")}>
            <strong>Leave register</strong><i>{allRequests.length}</i>
          </button>
          {canReview ? <button className={section === "approvals" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "approvals"} ref={section === "approvals" ? revealSelectedLeaveTab : undefined} onClick={() => onSection("approvals")}>
            <strong>Approvals</strong><i>{pending.length}</i>
          </button> : null}
          {canAccessBalance ? <button className={section === "balance" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "balance"} ref={section === "balance" ? revealSelectedLeaveTab : undefined} onClick={() => onSection("balance")}>
            <strong>Balance</strong>
          </button> : null}
        </div>
      ) : null}
      {applyAction}
      </div>
      {section === "requests" ? <RequestsView profile={profile} requests={requests} allRequests={allRequests} selected={selected} filter={filter} canReview={canReview} attachmentsByRequestId={attachmentsByRequestId} readOnly={readOnly} hidePrivateDetails={hidePrivateDetails} canCancelOwnLeave={canCancelOwnLeave} mobileDetailOpen={mobileDetailOpen} cancellationRequestId={cancellationRequestId} cancellationError={cancellationError} cancelledRequestId={cancelledRequestId} busy={busy} onFilter={onFilter} onSelect={(id) => onSelect(id, "requests")} onViewMore={(id) => onSelect(id, "approvals")} onCloseMobileDetail={onCloseMobileDetail} onAddSupportingFiles={onAddSupportingFiles} onDeleteSupportingFile={onDeleteSupportingFile} onStartCancellation={onStartCancellation} onDismissCancellation={onDismissCancellation} onConfirmCancellation={onConfirmCancellation} /> : null}
      {section === "approvals" && canReview ? <ApprovalsView leavePriority={leavePriority} onBalancesSaved={onBalancesSaved} pending={pending} selected={selected} selectedId={selectedId} note={note} calendarRequests={calendarRequests} calendarCheckIns={calendarCheckIns} attachmentsByRequestId={attachmentsByRequestId} busy={busy} readOnly={readOnly} onNote={onNote} onSelect={(id) => onSelect(id, "approvals")} onDecision={onDecision} onDeleteSupportingFile={onDeleteSupportingFile} /> : null}
      {section === "balance" && canAccessBalance ? <div className={styles.balanceWorkspace}>{balanceContent}</div> : null}
    </section>
  );
}

function RequestsView({ profile, requests, allRequests, selected, filter, canReview, attachmentsByRequestId, readOnly, hidePrivateDetails, canCancelOwnLeave, mobileDetailOpen, cancellationRequestId, cancellationError, cancelledRequestId, busy, onFilter, onSelect, onViewMore, onCloseMobileDetail, onAddSupportingFiles, onDeleteSupportingFile, onStartCancellation, onDismissCancellation, onConfirmCancellation }: { profile: Profile; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected?: LeaveRequest; filter: "All" | RequestStatus; canReview: boolean; attachmentsByRequestId: Map<string, LeaveAttachment[]>; readOnly: boolean; hidePrivateDetails: boolean; canCancelOwnLeave: boolean; mobileDetailOpen: boolean; cancellationRequestId: string | null; cancellationError: string; cancelledRequestId: string | null; busy: boolean; onFilter: (filter: "All" | RequestStatus) => void; onSelect: (id: string) => void; onViewMore: (id: string) => void; onCloseMobileDetail: () => void; onAddSupportingFiles: (requestId: string, files: File[]) => Promise<void>; onDeleteSupportingFile: (attachmentId: string) => Promise<void>; onStartCancellation: (requestId: string) => void; onDismissCancellation: () => void; onConfirmCancellation: (requestId: string) => void }) {
  const filters: ("All" | RequestStatus)[] = ["All", "Pending", BALANCE_PENDING_STATUS, "Approved", "Declined", "Cancelled"];
  const isEmployee = !canReview;
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const mobileDetailDialogRef = useRef<HTMLElement>(null);
  const mobileDetailCloseButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 680px)");
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  const mobileDetailDialogOpen = Boolean(mobileDetailOpen && isMobileViewport && selected);
  useDialogFocus(
    mobileDetailDialogOpen,
    mobileDetailDialogRef,
    mobileDetailCloseButtonRef,
    onCloseMobileDetail,
  );

  return (
    <section className={styles.recordsWorkspace}>
      <div className={styles.viewToolbar}>
        <div className={styles.filterTabs} role="group" aria-label="Leave request status">{filters.map((item) => <button aria-pressed={filter === item} className={filter === item ? styles.filterActive : ""} type="button" onClick={() => onFilter(item)} key={item}>{item === BALANCE_PENDING_STATUS ? "Waiting for balance" : item}<span>{item === "All" ? allRequests.length : allRequests.filter((request) => request.status === item).length}</span></button>)}</div>
      </div>
      <div className={`${styles.recordsGrid} ${isEmployee ? styles.employeeRecordsGrid : ""} ${!selected ? styles.recordsGridNoDetail : ""} ${mobileDetailDialogOpen ? styles.recordsGridMobileDetailOpen : ""}`}>
        <div className={styles.recordsTable} role="table" aria-label="Leave requests">
          <div className={`${styles.tableHead} ${isEmployee ? styles.employeeTableRow : ""}`} role="row">{!isEmployee ? <span>Employee</span> : null}<span>Leave</span><span>Dates</span><span>Duration</span><span>Status</span><span /></div>
          {requests.map((request) => <button className={`${styles.tableRow} ${isEmployee ? styles.employeeTableRow : ""} ${selected?.id === request.id ? styles.tableRowActive : ""}`} type="button" onClick={() => onSelect(request.id)} role="row" key={request.id}>{!isEmployee ? <span><i>{request.initials}</i><b>{request.personId === profile.id ? "You" : request.employee}<small>{request.team}</small></b></span> : null}<span><b>{request.leaveType}</b></span><span>{request.dateLabel}</span><span>{formatDuration(request)}</span><span><StatusPill status={request.status} /></span><ChevronRight size={15} /></button>)}
          {!requests.length ? <div className={styles.emptyState}><Search size={23} /><strong>{allRequests.length ? "No matching requests" : "No leave requests"}</strong></div> : null}
        </div>
        {selected ? <>
          {mobileDetailDialogOpen ? <button className={styles.mobileDetailBackdrop} type="button" aria-label="Close leave details" onClick={onCloseMobileDetail} /> : null}
          <RequestDetail profile={profile} request={selected} attachments={attachmentsByRequestId.get(selected.id) ?? []} canReview={canReview} readOnly={readOnly} hidePrivateDetails={hidePrivateDetails} canCancelOwnLeave={canCancelOwnLeave} mobileOpen={mobileDetailDialogOpen} mobileDialogRef={mobileDetailDialogRef} mobileCloseButtonRef={mobileDetailCloseButtonRef} cancellationRequestId={cancellationRequestId} cancellationError={cancellationError} cancellationSucceeded={cancelledRequestId === selected.id} busy={busy} onViewMore={onViewMore} onCloseMobileDetail={onCloseMobileDetail} onAddSupportingFiles={onAddSupportingFiles} onDeleteSupportingFile={onDeleteSupportingFile} onStartCancellation={onStartCancellation} onDismissCancellation={onDismissCancellation} onConfirmCancellation={onConfirmCancellation} />
        </> : null}
      </div>
    </section>
  );
}

function RequestDetail({ profile, request, attachments, canReview, readOnly, hidePrivateDetails, canCancelOwnLeave, mobileOpen, mobileDialogRef, mobileCloseButtonRef, cancellationRequestId, cancellationError, cancellationSucceeded, busy, onViewMore, onCloseMobileDetail, onAddSupportingFiles, onDeleteSupportingFile, onStartCancellation, onDismissCancellation, onConfirmCancellation }: { profile: Profile; request: LeaveRequest; attachments: LeaveAttachment[]; canReview: boolean; readOnly: boolean; hidePrivateDetails: boolean; canCancelOwnLeave: boolean; mobileOpen: boolean; mobileDialogRef: RefObject<HTMLElement | null>; mobileCloseButtonRef: RefObject<HTMLButtonElement | null>; cancellationRequestId: string | null; cancellationError: string; cancellationSucceeded: boolean; busy: boolean; onViewMore: (id: string) => void; onCloseMobileDetail: () => void; onAddSupportingFiles: (requestId: string, files: File[]) => Promise<void>; onDeleteSupportingFile: (attachmentId: string) => Promise<void>; onStartCancellation: (requestId: string) => void; onDismissCancellation: () => void; onConfirmCancellation: (requestId: string) => void }) {
  const detailTitleId = useId();
  const showEmployee = canReview && request.personId !== profile.id;
  const isConfirmingCancellation = cancellationRequestId === request.id;
  const isCancelled = request.status === "Cancelled" || cancellationSucceeded;
  const canCancel = !readOnly
    && !isCancelled
    && canCancelOwnLeave
    && request.canCancel === true;
  const canAddAttachments = !readOnly && request.canAttach === true;
  return <aside
    aria-label={mobileOpen ? undefined : `${request.leaveType} leave details`}
    aria-labelledby={mobileOpen ? detailTitleId : undefined}
    aria-modal={mobileOpen || undefined}
    className={`${styles.detailPanel} ${mobileOpen ? styles.mobileDetailPanelOpen : styles.mobileDetailPanelClosed}`}
    ref={mobileDialogRef}
    role={mobileOpen ? "dialog" : undefined}
    tabIndex={mobileOpen ? -1 : undefined}
  >
    {mobileOpen ? <button className={styles.mobileDetailClose} type="button" aria-label="Close leave details" onClick={onCloseMobileDetail} ref={mobileCloseButtonRef}><X aria-hidden="true" size={18} /></button> : null}
    {showEmployee ? <>
      <header>
        <span className={styles.avatarOrange}>{request.initials}</span>
        <span><h2 id={detailTitleId}>{request.employee}</h2></span>
      </header>
      <StatusPill status={request.status} />
    </> : null}
    {!showEmployee ? <div className={styles.mobileDetailHeading}><span><h2 id={detailTitleId}>{request.leaveType}</h2></span><StatusPill status={request.status} /></div> : null}
    <dl>
      {showEmployee ? <div><dt>Leave type</dt><dd>{request.leaveType}</dd></div> : null}
      <div><dt>When</dt><dd>{request.dateLabel}</dd></div>
      <div><dt>Duration</dt><dd>{formatDurationWithTime(request)}</dd></div>
      <div><dt>Assigned reviewer</dt><dd>{request.approvalRequired ? request.assignedReviewerLabel ?? "Authorised reviewer" : "Not required"}</dd></div>
    </dl>
    {canCancel ? <section className={styles.cancelLeaveAction}>{!isConfirmingCancellation ? <button id={cancelLeaveTriggerId(request.id)} className={styles.cancelLeaveButton} type="button" onClick={() => onStartCancellation(request.id)} disabled={busy}><XCircle aria-hidden="true" size={16} /> Cancel leave</button> : <><span>Cancel leave?</span><p>This cannot be undone.</p>{cancellationError ? <p className={styles.cancelLeaveError} role="alert">{cancellationError}</p> : null}<div className={styles.cancelLeaveControls}><button className={styles.cancelLeaveKeepButton} type="button" onClick={onDismissCancellation} disabled={busy}>Keep leave</button><button className={styles.cancelLeaveConfirmButton} type="button" onClick={() => onConfirmCancellation(request.id)} disabled={busy}><XCircle aria-hidden="true" size={16} /> {busy ? "Cancelling…" : "Cancel leave"}</button></div></>}</section> : null}
    {!hidePrivateDetails && request.employeeNote ? <section><span>{request.approvalRequired ? "Employee note" : "Private note"}</span><p>{request.employeeNote}</p></section> : null}
    {!hidePrivateDetails && request.managerNote ? <section><span>Reviewer decision note</span><p>{request.managerNote}</p></section> : null}
    {!hidePrivateDetails ? <AttachmentList attachments={attachments} busy={busy} onDelete={onDeleteSupportingFile} /> : null}
    {!hidePrivateDetails && request.status !== "Declined" && request.status !== "Cancelled" ? <SickEvidenceNotice dueDate={request.evidenceDueDate} hasEvidence={attachments.length > 0} /> : null}
    {!hidePrivateDetails && canAddAttachments ? <section className={styles.attachmentUpload}>

      {attachments.length ? <p>{attachments.length} of {MAX_LEAVE_ATTACHMENTS} files</p> : null}
      <label className={styles.attachmentUploadButton} data-busy={busy ? "true" : "false"}>
        <Upload aria-hidden="true" size={15} /> {busy ? "Uploading…" : "Add files"}
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
      <small>PDF or image · Max 5 MB</small>
    </section> : null}
    {canReview && request.canDecide ? <button className={`${styles.primaryButton} ${styles.viewMoreButton}`} type="button" disabled={busy} onClick={() => onViewMore(request.id)}>View more <ChevronRight size={16} aria-hidden="true" /></button> : null}
  </aside>;
}

function AttachmentList({ attachments, busy = false, onDelete }: { attachments: LeaveAttachment[]; busy?: boolean; onDelete?: (attachmentId: string) => Promise<void> }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  if (!attachments.length) return null;

  return <section className={styles.attachmentList} aria-label="Supporting files">
    <span><Paperclip aria-hidden="true" size={14} /> Supporting files</span>
    {attachments.map((attachment) => <div className={styles.attachmentItem} key={attachment.id}>
      <div className={styles.attachmentItemActions}>
        <a href={`/leave/attachments/${attachment.id}`}>
          <FileText aria-hidden="true" size={17} />
          <span><strong>{attachment.fileName}</strong><small>{formatFileSize(attachment.sizeBytes)} · Download</small></span>
          <ArrowUpRight aria-hidden="true" size={15} />
        </a>
        {attachment.canDelete && onDelete ? <button className={styles.attachmentDeleteButton} type="button" aria-label={`Delete ${attachment.fileName}`} aria-expanded={confirmDeleteId === attachment.id} onClick={() => setConfirmDeleteId(attachment.id)} disabled={busy} title="Delete file"><Trash2 aria-hidden="true" size={15} /><span>Delete</span></button> : null}
      </div>
      {attachment.canDelete && onDelete && confirmDeleteId === attachment.id ? <div className={styles.attachmentDeleteConfirm} role="group" aria-label={`Confirm deletion of ${attachment.fileName}`}>
        <span><strong>Delete this file?</strong><small>This cannot be undone.</small></span>
        <div>
          <button className={styles.attachmentDeleteKeepButton} type="button" onClick={() => setConfirmDeleteId(null)} disabled={busy}>Cancel</button>
          <button className={styles.attachmentDeleteConfirmButton} type="button" onClick={() => void onDelete(attachment.id)} disabled={busy}><Trash2 aria-hidden="true" size={14} />{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </div> : null}
    </div>)}
  </section>;
}

function ApprovalsView({ leavePriority, onBalancesSaved, pending, selected, selectedId, note, calendarRequests, calendarCheckIns, attachmentsByRequestId, busy, readOnly, onNote, onSelect, onDecision, onDeleteSupportingFile }: { leavePriority?: LeavePriorityWorkspace; onBalancesSaved: () => Promise<void>; pending: LeaveRequest[]; selected?: LeaveRequest; selectedId: string; note: string; calendarRequests: LeaveRequest[]; calendarCheckIns: CheckInCalendarEntry[]; attachmentsByRequestId: Map<string, LeaveAttachment[]>; busy: boolean; readOnly: boolean; onNote: (note: string) => void; onSelect: (id: string) => void; onDecision: (status: LeaveDecision) => void; onDeleteSupportingFile: (attachmentId: string) => Promise<void> }) {
  const person = leavePriority?.people.find((person) => person.personId === selected?.personId);
  const coverage = selected ? approvalBalanceCoverage(person, selected.leaveType, approvalRequestHours(selected)) : null;
  const annual = selected?.leaveType === "Annual leave";
  const insufficient = annual && coverage === "Not enough balance";
  const needsCheck = annual && coverage !== "Enough balance" && !insufficient;
  const waiting = insufficient && selected?.status === BALANCE_PENDING_STATUS;
  const approvalLabel = needsCheck ? "Check balance" : waiting ? "Waiting for balance" : insufficient ? "Approve pending balance" : "Approve";
  const showQueue = pending.length > 1 || !selected;
  return <div className={`${styles.approvalGrid} ${!selected ? styles.approvalGridEmpty : ""} ${!showQueue ? styles.approvalGridSingle : ""}`}>
    {showQueue ? <section className={`${styles.panel} ${styles.queue}`}><PanelHeader title="Requests" />{pending.length ? pending.map((request) => <button className={selectedId === request.id ? styles.queueActive : ""} type="button" onClick={() => onSelect(request.id)} disabled={busy} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small></span><ChevronRight size={16} /></button>) : <div className={styles.emptyState}><CheckCircle2 size={25} /><strong>Nothing needs review</strong></div>}</section> : null}
    {selected ? <section className={`${styles.panel} ${styles.approvalRecord}`}>
      <header className={styles.approvalHeader}><span className={styles.avatarOrange}>{selected.initials}</span><span><h2>{selected.employee}</h2></span><StatusPill status={selected.status} /></header>
      <strong className={styles.requestDetailsHeading}>Request details</strong>
      <div className={styles.factGrid}><article><CalendarDays size={17} /><span><strong>{selected.dateLabel}</strong></span></article><article><Clock3 size={17} /><span><span className={styles.approvalDuration}><strong>{formatDuration(selected)}</strong>{selected.hours == null && approvalRequestHours(selected) != null ? <span>{approvalRequestHours(selected)} hours</span> : null}<ApprovalBalancePill workspace={leavePriority} personId={selected.personId} leaveType={selected.leaveType} requiredHours={approvalRequestHours(selected)} /></span>{formatTimeRange(selected) ? <small>{formatTimeRange(selected)}</small> : null}</span></article><article><ClipboardList size={17} /><span><strong>{selected.leaveType}</strong></span></article></div>
      <ApprovalLeaveBalances key={`balances:${selected.id}`} workspace={leavePriority} personId={selected.personId} requestId={selected.id} busy={busy || readOnly} onSaved={onBalancesSaved} />
      {selected.employeeNote ? <div className={styles.privateNote}><span>Note</span><p>{selected.employeeNote}</p></div> : null}
      <AttachmentList attachments={attachmentsByRequestId.get(selected.id) ?? []} busy={busy} onDelete={onDeleteSupportingFile} />
      <SickEvidenceNotice dueDate={selected.evidenceDueDate} hasEvidence={(attachmentsByRequestId.get(selected.id)?.length ?? 0) > 0} />
      {selected.status === "Pending" || selected.status === BALANCE_PENDING_STATUS ? <div className={styles.decisionBox}>
        <label><span>Note <small>Required to decline</small></span><textarea rows={2} value={note} onChange={(event) => onNote(event.target.value)} disabled={busy || readOnly} /></label>
        <div>
          <button className={styles.declineButton} type="button" onClick={() => onDecision("Declined")} disabled={busy || readOnly}><XCircle size={16} /> Decline</button>
          <button className={styles.approveButton} type="button" onClick={() => onDecision(insufficient ? BALANCE_PENDING_STATUS : "Approved")} disabled={busy || readOnly || needsCheck || waiting}><CheckCircle2 size={16} /> {busy ? "Sending…" : approvalLabel}</button>
        </div>
      </div> : null}
      <ApprovalCalendar key={`calendar:${selected.id}`} selected={selected} requests={calendarRequests} checkIns={calendarCheckIns} />
    </section> : null}
  </div>;
}

function ApprovalCalendar({ selected, requests, checkIns }: { selected: LeaveRequest; requests: LeaveRequest[]; checkIns: CheckInCalendarEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const calendarId = useId();
  const days = getApprovalCalendarDays(selected, expanded);
  const rangeStart = days[0].iso;
  const rangeEnd = days[days.length - 1].iso;
  const teamLeave = requests.filter((request) => request.id !== selected.id && request.personId !== selected.personId && request.team === selected.team && request.status !== "Declined" && request.status !== "Cancelled" && request.endDate >= rangeStart && request.startDate <= rangeEnd);
  const rangeCheckIns = checkIns.filter((entry) => entry.dueDate >= rangeStart && entry.dueDate <= rangeEnd);

  return (
    <section className={styles.calendarImpact} aria-label="Team calendar">
      <div className={styles.impactLegend} aria-label="Calendar legend">
        <span><i className={styles.legendApplicant} />This request</span>
        <span><i className={styles.legendApproved} />Approved leave</span>
        <span><i className={styles.legendPending} />Pending leave</span>
        <span><i className={styles.legendCheckIn} />Check-in</span>
      </div>
      <div id={calendarId} role="region" className={styles.reviewCalendarViewport} tabIndex={0} aria-label="Scrollable team calendar comparison">
        <div className={styles.reviewCalendar} role="grid" aria-label={`Team calendar from ${formatDateRange(rangeStart, rangeEnd)}`}>
          <div className={styles.reviewCalendarWeek} role="row">
            {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((weekday) => <span role="columnheader" key={weekday}>{weekday}</span>)}
          </div>
          <div className={styles.reviewCalendarGrid}>
            {days.map((day, index) => {
              const isRequestedDay = day.iso >= selected.startDate && day.iso <= selected.endDate;
              const otherLeave = teamLeave.filter((request) => day.iso >= request.startDate && day.iso <= request.endDate);
              const dayCheckIns = rangeCheckIns.filter((entry) => entry.dueDate === day.iso);
              return (
                <div className={`${styles.reviewCalendarDay} ${day.isWeekend ? styles.reviewCalendarWeekend : ""} ${isRequestedDay ? styles.reviewCalendarRequestedDay : ""}`} role="gridcell" key={day.iso}>
                  <time dateTime={day.iso}><b>{day.day}</b>{day.day === 1 || index === 0 ? <span>{day.month}</span> : null}</time>
                  {isRequestedDay ? <article className={styles.reviewEventApplicant}><i>{selected.initials}</i><span><strong>{selected.employee}</strong><small>{formatTimeRange(selected) || "This request"}</small></span></article> : null}
                  {otherLeave.map((request) => <article className={request.status === "Approved" ? styles.reviewEventApproved : styles.reviewEventPending} key={request.id}><i>{request.initials}</i><span><strong>{request.employee}</strong><small>{formatTimeRange(request) || `${request.status} leave`}</small></span></article>)}
                  {dayCheckIns.map((entry) => <article className={styles.reviewEventCheckIn} key={`checkin:${entry.reminderId}`}><i>CI</i><span><strong>{entry.employee}</strong><small>{checkInMilestoneLabel(entry.milestone)}{entry.sequence === "final" ? " · final reminder" : ""}</small></span></article>)}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <button className={styles.calendarExpandButton} type="button" aria-expanded={expanded} aria-controls={calendarId} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Collapse calendar" : "Expand calendar"}
      </button>
    </section>
  );
}
