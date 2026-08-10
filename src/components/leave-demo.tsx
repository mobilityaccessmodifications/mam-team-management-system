"use client";

import {
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock3,
  Eye,
  FileImage,
  FileText,
  LayoutDashboard,
  MoreHorizontal,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import styles from "@/components/leave-demo.module.css";
import { createClient } from "@/lib/supabase/client";
import { isSharedDemoConfigured } from "@/lib/supabase/config";

type AppView = "home" | "leave" | "calendar";
type LeaveSection = "requests" | "approvals";
type RequestStatus = "Pending" | "Approved" | "Declined";
type AccessRole = "hr" | "manager" | "employee";

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
};

type CalendarHoliday = {
  date: string;
  label: string;
  isDemo?: boolean;
};

type SharedDataState = "local" | "connecting" | "live" | "error";

type DemoLeaveRequestRow = {
  id: string;
  employee_profile_id: string;
  manager_profile_id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  days: number | string;
  hours: number | string | null;
  approval_required: boolean;
  status: RequestStatus;
  submitted_at: string;
  employee_note: string;
  manager_note: string | null;
};

const demoCalendarHolidays: CalendarHoliday[] = [
  { date: "2026-08-31", label: "Public holiday", isDemo: true },
];

const initialRequests: LeaveRequest[] = [
  {
    id: "MAM-2403",
    employee: "Jordan Patel",
    initials: "JP",
    team: "Major Modifications",
    leaveType: "Annual leave",
    startDate: "2026-08-17",
    endDate: "2026-08-19",
    dateLabel: "17–19 Aug 2026",
    days: 3,
    approvalRequired: true,
    status: "Pending",
    submittedAt: "Today, 8:42 am",
    manager: "Taylor Morgan",
    employeeNote: "Family trip booked interstate.",
  },
  {
    id: "MAM-2402",
    employee: "Mia Chen",
    initials: "MC",
    team: "Minor Modifications",
    leaveType: "Sick leave",
    startDate: "2026-08-18",
    endDate: "2026-08-18",
    dateLabel: "18 Aug 2026",
    days: 1,
    hours: 4,
    startTime: "09:00",
    endTime: "13:00",
    approvalRequired: true,
    status: "Pending",
    submittedAt: "Yesterday, 3:24 pm",
    manager: "Riley Brooks",
    employeeNote: "Personal appointment.",
  },
  {
    id: "MAM-2401",
    employee: "Noah Williams",
    initials: "NW",
    team: "Major Modifications",
    leaveType: "Annual leave",
    startDate: "2026-08-18",
    endDate: "2026-08-20",
    dateLabel: "18–20 Aug 2026",
    days: 3,
    approvalRequired: true,
    status: "Approved",
    submittedAt: "29 Jul, 10:08 am",
    manager: "Taylor Morgan",
    employeeNote: "Planned annual leave.",
    managerNote: "Project handover is complete.",
  },
  {
    id: "MAM-2398",
    employee: "Taylor Morgan",
    initials: "TM",
    team: "Major Modifications",
    leaveType: "Annual leave",
    startDate: "2026-09-07",
    endDate: "2026-09-11",
    dateLabel: "7–11 Sep 2026",
    days: 5,
    approvalRequired: false,
    status: "Approved",
    submittedAt: "30 Jul, 2:16 pm",
    manager: "Priya Singh",
    employeeNote: "School holiday break.",
  },
  {
    id: "MAM-2396",
    employee: "Taylor Morgan",
    initials: "TM",
    team: "Major Modifications",
    leaveType: "Annual leave",
    startDate: "2026-07-06",
    endDate: "2026-07-10",
    dateLabel: "6–10 Jul 2026",
    days: 5,
    approvalRequired: false,
    status: "Approved",
    submittedAt: "22 Jun, 4:16 pm",
    manager: "Priya Singh",
    employeeNote: "Planned leave.",
  },
  {
    id: "MAM-2397",
    employee: "Riley Brooks",
    initials: "RB",
    team: "Minor Modifications",
    leaveType: "Annual leave",
    startDate: "2026-09-14",
    endDate: "2026-09-18",
    dateLabel: "14–18 Sep 2026",
    days: 5,
    approvalRequired: false,
    status: "Approved",
    submittedAt: "30 Jul, 9:35 am",
    manager: "Priya Singh",
    employeeNote: "Planned annual leave.",
  },
  {
    id: "MAM-2395",
    employee: "Ava Thompson",
    initials: "AT",
    team: "Accounts",
    leaveType: "Unpaid leave",
    startDate: "2026-07-31",
    endDate: "2026-07-31",
    dateLabel: "31 Jul 2026",
    days: 1,
    approvalRequired: true,
    status: "Declined",
    submittedAt: "28 Jul, 1:14 pm",
    manager: "Priya Singh",
    employeeNote: "Personal commitment.",
    managerNote: "Please choose another date due to payroll close.",
  },
];

const profiles: Profile[] = [
  { id: "priya", name: "Priya Singh", initials: "PS", accessRole: "hr", roleLabel: "HR & People", team: "People & Culture", manager: "Executive Team" },
  { id: "taylor", name: "Taylor Morgan", initials: "TM", accessRole: "manager", roleLabel: "Major Mod manager", team: "Major Modifications", manager: "Priya Singh" },
  { id: "riley", name: "Riley Brooks", initials: "RB", accessRole: "manager", roleLabel: "Minor Mod manager", team: "Minor Modifications", manager: "Priya Singh" },
  { id: "jordan", name: "Jordan Patel", initials: "JP", accessRole: "employee", roleLabel: "Accessibility technician", team: "Major Modifications", manager: "Taylor Morgan" },
  { id: "noah", name: "Noah Williams", initials: "NW", accessRole: "employee", roleLabel: "Project coordinator", team: "Major Modifications", manager: "Taylor Morgan" },
  { id: "alex", name: "Alex King", initials: "AK", accessRole: "employee", roleLabel: "Accessibility carpenter", team: "Major Modifications", manager: "Taylor Morgan" },
  { id: "mia", name: "Mia Chen", initials: "MC", accessRole: "employee", roleLabel: "Modifications coordinator", team: "Minor Modifications", manager: "Riley Brooks" },
  { id: "sam", name: "Sam Rivera", initials: "SR", accessRole: "employee", roleLabel: "Modifications tradesperson", team: "Minor Modifications", manager: "Riley Brooks" },
  { id: "ava", name: "Ava Thompson", initials: "AT", accessRole: "employee", roleLabel: "Accounts officer", team: "Accounts", manager: "Priya Singh" },
];

function formatSubmittedAt(value: string) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function mapDemoLeaveRequest(row: DemoLeaveRequestRow): LeaveRequest {
  const employee = profiles.find((profile) => profile.id === row.employee_profile_id);
  const manager = profiles.find((profile) => profile.id === row.manager_profile_id);

  if (!employee || !manager) {
    throw new Error(`Synthetic profile mapping is missing for ${row.id}.`);
  }

  return {
    id: row.id,
    employee: employee.name,
    initials: employee.initials,
    team: employee.team,
    leaveType: row.leave_type,
    startDate: row.start_date,
    endDate: row.end_date,
    dateLabel: formatDateRange(row.start_date, row.end_date),
    days: Number(row.days),
    hours: row.hours === null ? undefined : Number(row.hours),
    startTime: row.start_time?.slice(0, 5),
    endTime: row.end_time?.slice(0, 5),
    approvalRequired: row.approval_required,
    status: row.status,
    submittedAt: formatSubmittedAt(row.submitted_at),
    manager: manager.name,
    employeeNote: row.employee_note,
    managerNote: row.manager_note ?? undefined,
  };
}

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

function releaseAttachmentUrls(requests: LeaveRequest[]) {
  requests.forEach((request) => {
    request.attachments?.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  });
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

function formatMonthCode(date: string) {
  return ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(date.slice(5, 7)) - 1];
}

function toIsoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getApprovalCalendarDays(request: LeaveRequest) {
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
      month: current.toLocaleDateString("en-AU", { month: "short" }),
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

function getViewTitles(profile: Profile, leaveSection: LeaveSection): Record<AppView, { title: string; eyebrow: string }> {
  return {
    home: { title: `Good morning, ${profile.name.split(" ")[0]}`, eyebrow: "Tuesday · 4 August" },
    leave: {
      title: profile.accessRole === "employee" ? "My leave" : "Leave",
      eyebrow: leaveSection === "approvals" ? `${profile.team} decision queue` : profile.roleLabel,
    },
    calendar: { title: "Team calendar", eyebrow: "August 2026" },
  };
}

function getVisibleRequests(requests: LeaveRequest[], profile: Profile) {
  if (profile.accessRole === "hr") return requests;
  if (profile.accessRole === "manager") {
    return requests.filter((request) => request.team === profile.team || request.employee === profile.name);
  }
  return requests.filter((request) => request.employee === profile.name);
}

function getCalendarRequests(requests: LeaveRequest[], profile: Profile) {
  if (profile.accessRole === "hr") return requests;
  return requests.filter((request) => request.team === profile.team);
}

export function LeaveDemo() {
  const supabase = isSharedDemoConfigured() ? createClient() : null;
  const [activeView, setActiveView] = useState<AppView>("home");
  const [activeProfileId, setActiveProfileId] = useState("taylor");
  const [requests, setRequests] = useState<LeaveRequest[]>(initialRequests);
  const [selectedRequestId, setSelectedRequestId] = useState("MAM-2403");
  const [leaveSection, setLeaveSection] = useState<LeaveSection>("requests");
  const [statusFilter, setStatusFilter] = useState<"All" | RequestStatus>("All");
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [managerNote, setManagerNote] = useState("");
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");
  const [showProfiles, setShowProfiles] = useState(false);
  const [sharedDataState, setSharedDataState] = useState<SharedDataState>(supabase ? "connecting" : "local");

  useEffect(() => {
    if (!supabase) return;

    let mounted = true;
    let refreshTimer: number | undefined;

    async function loadSharedRequests() {
      const { data, error } = await supabase
        .from("demo_leave_requests")
        .select("*")
        .order("submitted_at", { ascending: false })
        .order("id", { ascending: false });

      if (!mounted) return;

      if (error) {
        setSharedDataState("error");
        return;
      }

      try {
        const nextRequests = (data as DemoLeaveRequestRow[]).map(mapDemoLeaveRequest);
        setRequests((current) => nextRequests.map((request) => {
          const localAttachments = current.find((item) => item.id === request.id)?.attachments;
          return localAttachments?.length ? { ...request, attachments: localAttachments } : request;
        }));
        setSelectedRequestId((current) => nextRequests.some((request) => request.id === current) ? current : nextRequests[0]?.id ?? current);
        setSharedDataState("live");
      } catch {
        setSharedDataState("error");
      }
    }

    void loadSharedRequests();

    const channel = supabase
      .channel("demo:leave_requests")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "demo_leave_requests" },
        () => {
          window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void loadSharedRequests(), 120);
        },
      )
      .subscribe((status: string) => {
        if (!mounted) return;
        if (status === "SUBSCRIBED") setSharedDataState("live");
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSharedDataState("error");
      });

    return () => {
      mounted = false;
      window.clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[1];
  const viewTitles = getViewTitles(activeProfile, leaveSection);
  const visibleRequests = getVisibleRequests(requests, activeProfile);
  const calendarRequests = getCalendarRequests(requests, activeProfile);
  const approvalQueue = activeProfile.accessRole === "manager"
    ? requests.filter((request) => request.approvalRequired && request.status === "Pending" && request.manager === activeProfile.name)
    : [];
  const myRequests = requests.filter((request) => request.employee === activeProfile.name);
  const selectedRequest = visibleRequests.find((request) => request.id === selectedRequestId) ?? approvalQueue[0] ?? visibleRequests[0] ?? requests[0];
  const filteredRequests = visibleRequests.filter((request) => {
    return statusFilter === "All" || request.status === statusFilter;
  });

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function chooseLeaveSection(section: LeaveSection) {
    if (section === "approvals" && activeProfile.accessRole !== "manager") return;
    if (section === "approvals" && approvalQueue[0]) setSelectedRequestId(approvalQueue[0].id);
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
    chooseLeaveSection(section);
    setActiveView("leave");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function resetDemo() {
    if (supabase) {
      setSharedDataState("connecting");
      const { data, error } = await supabase.rpc("reset_demo_leave_requests", {
        p_confirm_synthetic: true,
      });
      if (error) {
        setSharedDataState("error");
        announce("The shared demo could not be reset. Try again in a moment.");
        return;
      }
      const nextRequests = (data as DemoLeaveRequestRow[]).map(mapDemoLeaveRequest);
      setRequests((current) => {
        releaseAttachmentUrls(current);
        return nextRequests;
      });
      setSharedDataState("live");
    } else {
      setRequests((current) => {
        releaseAttachmentUrls(current);
        return initialRequests;
      });
    }
    setSelectedRequestId("MAM-2403");
    setActiveView("home");
    setLeaveSection("requests");
    setStatusFilter("All");
    setShowRequestForm(false);
    setManagerNote("");
    setShowProfiles(false);
    announce(supabase ? "Shared fake data reset for every open demo." : "Demo reset to its starting point.");
  }

  function switchProfile(profile: Profile) {
    setActiveProfileId(profile.id);
    setActiveView("home");
    setLeaveSection("requests");
    setSelectedRequestId(initialRequests.find((request) => request.employee === profile.name)?.id ?? initialRequests[0].id);
    setStatusFilter("All");
    setManagerNote("");
    setShowProfiles(false);
    announce(`Now viewing the demo as ${profile.name} · ${profile.roleLabel}.`);
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setFormError("Choose at least one weekday for this demo request.");
      return;
    }
    const nextNumber = Math.max(...requests.map((request) => Number(request.id.split("-")[1]))) + 1;
    const approvalRequired = activeProfile.accessRole !== "manager";
    const attachments = attachmentFiles.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
    }));
    const next: LeaveRequest = {
      id: `MAM-${nextNumber}`,
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

    let savedRequest = next;
    if (supabase) {
      const { data: saved, error } = await supabase.rpc("submit_demo_leave_request", {
        p_employee_profile_id: activeProfile.id,
        p_leave_type: leaveType,
        p_start_date: startDate,
        p_end_date: endDate,
        p_start_time: startTime || null,
        p_end_time: endTime || null,
        p_employee_note: employeeNote || null,
      });

      if (error || !saved) {
        attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        setFormError(error?.message ?? "The shared request could not be saved.");
        setSharedDataState("error");
        return;
      }

      savedRequest = { ...mapDemoLeaveRequest(saved as DemoLeaveRequestRow), attachments };
      setSharedDataState("live");
    }

    setRequests((current) => [savedRequest, ...current.filter((request) => request.id !== savedRequest.id)]);
    setSelectedRequestId(savedRequest.id);
    setShowRequestForm(false);
    setFormError("");
    form.reset();
    navigate("leave");
    announce(savedRequest.approvalRequired
      ? `${savedRequest.id} sent to ${activeProfile.manager} for review${supabase ? " and synced live" : ""}.`
      : `${savedRequest.id} added to the team calendar${supabase ? " and synced live" : ""}. No approval is needed.`);
  }

  async function decideRequest(status: "Approved" | "Declined") {
    if (status === "Declined" && !managerNote.trim()) {
      announce("Add a manager comment before declining this request.");
      return;
    }
    let decidedRequest: LeaveRequest = {
      ...selectedRequest,
      status,
      managerNote: managerNote.trim() || "Coverage checked and confirmed.",
    };

    if (supabase) {
      const { data: decided, error } = await supabase.rpc("decide_demo_leave_request", {
        p_request_id: selectedRequest.id,
        p_actor_profile_id: activeProfile.id,
        p_status: status,
        p_manager_note: managerNote.trim() || null,
      });

      if (error || !decided) {
        announce(error?.message ?? "The shared decision could not be saved.");
        setSharedDataState("error");
        return;
      }

      decidedRequest = { ...mapDemoLeaveRequest(decided as DemoLeaveRequestRow), attachments: selectedRequest.attachments };
      setSharedDataState("live");
    }

    setRequests((current) => current.map((request) => request.id === selectedRequest.id ? decidedRequest : request));
    setManagerNote("");
    announce(`${selectedRequest.id} ${status.toLowerCase()}. The employee record and register are updated.`);
  }

  const navGroups = [
    { label: "Leave", items: [
      { id: "home" as AppView, label: "Home", icon: LayoutDashboard },
      { id: "leave" as AppView, label: "Leave", icon: ClipboardList, badge: activeProfile.accessRole === "manager" ? approvalQueue.length : undefined },
      { id: "calendar" as AppView, label: "Team calendar", icon: CalendarDays },
    ] },
  ];

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">Skip to workspace</a>
      <aside className={styles.sidebar} aria-label="MAM workspace navigation">
        <div className={styles.brandRow}><BrandMark /><button type="button" aria-label="Workspace options"><MoreHorizontal size={17} /></button></div>
        <div className={styles.demoBadge} data-state={sharedDataState} role="status">
          <Sparkles size={13} />
          {sharedDataState === "live" ? "Live demo · shared fake data" : null}
          {sharedDataState === "connecting" ? "Connecting shared fake data…" : null}
          {sharedDataState === "error" ? "Shared data connection issue" : null}
          {sharedDataState === "local" ? "Safe demo · browser-only data" : null}
        </div>
        <nav className={styles.nav}>
          {navGroups.map((group) => (
            <div className={styles.navGroup} key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button className={`${styles.navItem} ${activeView === item.id ? styles.navItemActive : ""}`} type="button" onClick={() => navigate(item.id)} key={item.id}>
                    <Icon size={17} strokeWidth={1.8} /><b>{item.label}</b>{item.badge ? <i>{item.badge}</i> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <span className={styles.avatarDark}>{activeProfile.initials}</span>
          <span><strong>{activeProfile.name}</strong><small>{activeProfile.roleLabel}</small></span>
          <MoreHorizontal size={16} />
        </div>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.mobileBrand}><BrandMark compact /></div>
          <div className={styles.topActions}>
            <button className={styles.resetButton} type="button" onClick={resetDemo}><RotateCcw size={14} /> Reset demo</button>
            <ProfileSwitcher activeProfile={activeProfile} open={showProfiles} onToggle={() => setShowProfiles((current) => !current)} onSelect={switchProfile} />
          </div>
        </header>

        <main className={styles.main} id="main-content">
          <section className={styles.pageHeader}>
            <div><p>{viewTitles[activeView].eyebrow}</p><h1>{viewTitles[activeView].title}</h1></div>
            <button className={styles.primaryButton} type="button" onClick={() => setShowRequestForm(true)}><Plus size={17} /> {activeProfile.accessRole === "manager" ? "Add leave" : "New leave request"}</button>
          </section>

          {activeView === "home" ? <HomeView profile={activeProfile} requests={calendarRequests} myRequests={myRequests} pending={approvalQueue} onNavigate={navigate} onSelect={selectRequest} /> : null}
          {activeView === "leave" ? <LeaveView profile={activeProfile} section={leaveSection} requests={filteredRequests} allRequests={visibleRequests} selected={selectedRequest} filter={statusFilter} pending={approvalQueue} selectedId={selectedRequestId} note={managerNote} calendarRequests={calendarRequests} onFilter={setStatusFilter} onSection={chooseLeaveSection} onNote={setManagerNote} onSelect={selectRequest} onDecision={decideRequest} /> : null}
          {activeView === "calendar" ? <CalendarView requests={calendarRequests} /> : null}
        </main>
      </div>

      {showRequestForm ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowRequestForm(false)}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="new-request-title">
            <header><div><span>{activeProfile.accessRole === "manager" ? "New calendar entry" : "New request"}</span><h2 id="new-request-title">{activeProfile.accessRole === "manager" ? "Add your leave" : "Request leave"}</h2></div><button type="button" onClick={() => setShowRequestForm(false)} aria-label="Close request form"><X size={19} /></button></header>
            <div className={styles.formPerson}><span className={styles.avatarOrange}>{activeProfile.initials}</span><span><strong>{activeProfile.name}</strong><small>{activeProfile.accessRole === "manager" ? `${activeProfile.team} · Added directly, no approval needed` : `${activeProfile.team} · Approver: ${activeProfile.manager}`}</small></span></div>
            <form className={styles.form} onSubmit={submitRequest}>
              <label><span>Leave type</span><select name="leaveType" defaultValue="Annual leave" required><option>Annual leave</option><option>Sick leave</option><option>Carer&apos;s leave</option><option>Unpaid leave</option></select></label>
              <div className={styles.formRow}><label><span>Start date</span><input name="startDate" type="date" defaultValue="2026-09-21" required /></label><label><span>End date</span><input name="endDate" type="date" defaultValue="2026-09-21" required /></label></div>
              <fieldset className={styles.timeRange}><legend>Start and end times <small>Optional</small></legend><div className={styles.formRow}><label><span>From · first day</span><select name="startTime" defaultValue=""><option value="">Select time</option>{START_TIME_OPTIONS.map((option) => <option value={option.value} key={`start-${option.value}`}>{option.label}</option>)}</select></label><label><span>To · last day</span><select name="endTime" defaultValue=""><option value="">Select time</option>{END_TIME_OPTIONS.map((option) => <option value={option.value} key={`end-${option.value}`}>{option.label}</option>)}</select></label></div><p>6:00 am–6:00 pm in 15-minute intervals. For multiple dates, these apply to the first and last day. Leave both blank for full working days.</p></fieldset>
              <label><span>{activeProfile.accessRole === "manager" ? "Private note" : "Note for your manager"} <small>Optional</small></span><textarea name="employeeNote" rows={3} placeholder={activeProfile.accessRole === "manager" ? "Add optional details for your own record." : "Add only what your manager needs to decide."} /></label>
              <label className={styles.attachmentField}><span>Supporting files <small>Optional</small></span><input className={styles.fileInput} name="attachments" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple /><small>PDF or images · up to 3 files, 5 MB each. Demo files stay in this open session.</small></label>
              <div className={styles.privacyNote}><ShieldCheck size={17} /><span>{activeProfile.accessRole === "manager" ? "Your note is private to you and HR." : "Your note is private to you, your approver and HR."} Coworkers only see that you are unavailable.</span></div>
              {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
              <footer><button className={styles.secondaryButton} type="button" onClick={() => setShowRequestForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit">{activeProfile.accessRole === "manager" ? "Add leave" : "Send request"} <ArrowUpRight size={16} /></button></footer>
            </form>
          </section>
        </div>
      ) : null}

      <div className={`${styles.toast} ${toast ? styles.toastVisible : ""}`} role="status" aria-live="polite"><CheckCircle2 size={17} />{toast}</div>
    </div>
  );
}

function ProfileSwitcher({ activeProfile, open, onToggle, onSelect }: { activeProfile: Profile; open: boolean; onToggle: () => void; onSelect: (profile: Profile) => void }) {
  const groups: { label: string; roles: AccessRole[] }[] = [
    { label: "People & Culture", roles: ["hr"] },
    { label: "Management", roles: ["manager"] },
    { label: "Employees", roles: ["employee"] },
  ];

  return (
    <div className={styles.profileSwitcher}>
      <button className={styles.profileTrigger} type="button" onClick={onToggle} aria-expanded={open} aria-haspopup="menu">
        <span className={`${styles.profileAvatar} ${styles[`profile${activeProfile.accessRole}`]}`}>{activeProfile.initials}</span>
        <span><strong>{activeProfile.name}</strong><small>{activeProfile.roleLabel}</small></span>
        <ChevronDown className={open ? styles.profileChevronOpen : ""} size={15} />
      </button>
      {open ? (
        <div className={styles.profileMenu} role="menu" aria-label="Select demo profile">
          <header><span>View demo as</span><small>Permissions and records change with each role</small></header>
          {groups.map((group) => (
            <section key={group.label}>
              <span>{group.label}</span>
              {profiles.filter((profile) => group.roles.includes(profile.accessRole)).map((profile) => (
                <button type="button" role="menuitem" onClick={() => onSelect(profile)} key={profile.id}>
                  <span className={`${styles.profileAvatar} ${styles[`profile${profile.accessRole}`]}`}>{profile.initials}</span>
                  <span><strong>{profile.name}</strong><small>{profile.roleLabel} · {profile.team}</small></span>
                  {profile.id === activeProfile.id ? <Check size={15} /> : null}
                </button>
              ))}
            </section>
          ))}
          <footer><ShieldCheck size={14} /> Synthetic demo profiles only</footer>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`${styles.status} ${styles[`status${status}`]}`}><i />{status}</span>;
}

function HomeView({ profile, requests, myRequests, pending, onNavigate, onSelect }: { profile: Profile; requests: LeaveRequest[]; myRequests: LeaveRequest[]; pending: LeaveRequest[]; onNavigate: (view: AppView, section?: LeaveSection) => void; onSelect: (id: string, section?: LeaveSection) => void }) {
  const nextOwn = myRequests.find((request) => request.status === "Pending") ?? myRequests[0];
  const attentionRequests = profile.accessRole === "manager" ? pending : profile.accessRole === "hr" ? requests.filter((request) => request.status === "Pending") : myRequests;
  const attentionTitle = profile.accessRole === "manager" ? "Your approval queue" : profile.accessRole === "hr" ? "Pending leave" : "My recent requests";
  const recordSection: LeaveSection = profile.accessRole === "manager" ? "approvals" : "requests";
  return (
    <div className={styles.dashboard}>
      <div className={styles.homeGrid}>
        <section className={`${styles.panel} ${styles.attentionPanel}`}>
          <PanelHeader kicker={profile.accessRole === "employee" ? "Personal" : "Needs attention"} title={attentionTitle} action="View all" onAction={() => onNavigate("leave", recordSection)} />
          <div className={styles.recordList}>
            {attentionRequests.slice(0, 3).map((request) => <button type="button" onClick={() => onSelect(request.id, recordSection)} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small></span><span className={styles.dayCount}>{request.hours ?? request.days}<small>{request.hours ? (request.hours === 1 ? "hour" : "hours") : request.days === 1 ? "day" : "days"}</small></span><ChevronRight size={16} /></button>)}
            {!attentionRequests.length ? <div className={styles.emptyState}><CheckCircle2 size={24} /><strong>Nothing waiting</strong><span>This profile has no pending records.</span></div> : null}
          </div>
        </section>

        <section className={`${styles.panel} ${styles.myLeavePanel}`}>
          <PanelHeader kicker="Personal" title="My leave" action="All requests" onAction={() => onNavigate("leave")} />
          {nextOwn ? <div className={styles.nextLeave}><span className={styles.dateBlock}><strong>{nextOwn.startDate.slice(8)}</strong><small>{formatMonthCode(nextOwn.startDate)}</small></span><span><StatusPill status={nextOwn.status} /><h3>{nextOwn.leaveType}</h3><p>{nextOwn.dateLabel} · {formatDurationWithTime(nextOwn)}</p></span></div> : <div className={styles.emptyState}><CalendarDays size={24} /><strong>No leave requests yet</strong><span>Use “New leave request” to try the employee flow.</span></div>}
        </section>
      </div>
    </div>
  );
}

function PanelHeader({ kicker, title, action, onAction }: { kicker: string; title: string; action?: string; onAction?: () => void }) {
  return <header className={styles.panelHeader}><div><span>{kicker}</span><h2>{title}</h2></div>{action && onAction ? <button type="button" onClick={onAction}>{action}<ChevronRight size={14} /></button> : null}</header>;
}

function LeaveView({ profile, section, requests, allRequests, selected, filter, pending, selectedId, note, calendarRequests, onFilter, onSection, onNote, onSelect, onDecision }: { profile: Profile; section: LeaveSection; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected: LeaveRequest; filter: "All" | RequestStatus; pending: LeaveRequest[]; selectedId: string; note: string; calendarRequests: LeaveRequest[]; onFilter: (filter: "All" | RequestStatus) => void; onSection: (section: LeaveSection) => void; onNote: (note: string) => void; onSelect: (id: string, section?: LeaveSection) => void; onDecision: (status: "Approved" | "Declined") => void }) {
  const canApprove = profile.accessRole === "manager";
  return (
    <section className={styles.leaveDesk}>
      {canApprove ? (
        <div className={styles.leaveSwitch} aria-label="Leave workspace">
          <button className={section === "requests" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "requests"} onClick={() => onSection("requests")}>
            <span><strong>Requests</strong><small>Team leave records</small></span><i>{allRequests.length}</i>
          </button>
          <button className={section === "approvals" ? styles.leaveSwitchActive : ""} type="button" aria-pressed={section === "approvals"} onClick={() => onSection("approvals")}>
            <span><strong>To approve</strong><small>Needs your decision</small></span><i>{pending.length}</i>
          </button>
        </div>
      ) : null}
      {section === "requests" ? <RequestsView profile={profile} requests={requests} allRequests={allRequests} selected={selected} filter={filter} onFilter={onFilter} onSelect={(id) => onSelect(id, "requests")} /> : null}
      {section === "approvals" && canApprove ? <ApprovalsView pending={pending} selected={selected} selectedId={selectedId} note={note} requests={calendarRequests} onNote={onNote} onSelect={(id) => onSelect(id, "approvals")} onDecision={onDecision} /> : null}
    </section>
  );
}

function RequestsView({ profile, requests, allRequests, selected, filter, onFilter, onSelect }: { profile: Profile; requests: LeaveRequest[]; allRequests: LeaveRequest[]; selected: LeaveRequest; filter: "All" | RequestStatus; onFilter: (filter: "All" | RequestStatus) => void; onSelect: (id: string) => void }) {
  const filters: ("All" | RequestStatus)[] = ["All", "Pending", "Approved", "Declined"];
  return (
    <section className={styles.recordsWorkspace}>
      <div className={styles.viewToolbar}>
        <div className={styles.filterTabs}>{filters.map((item) => <button className={filter === item ? styles.filterActive : ""} type="button" onClick={() => onFilter(item)} key={item}>{item}<span>{item === "All" ? allRequests.length : allRequests.filter((request) => request.status === item).length}</span></button>)}</div>
      </div>
      <div className={styles.recordsGrid}>
        <div className={styles.recordsTable} role="table" aria-label="Leave requests">
          <div className={styles.tableHead} role="row"><span>Employee</span><span>Leave type</span><span>Dates</span><span>Duration</span><span>Status</span><span /></div>
          {requests.map((request) => <button className={`${styles.tableRow} ${selected.id === request.id ? styles.tableRowActive : ""}`} type="button" onClick={() => onSelect(request.id)} role="row" key={request.id}><span><i>{request.initials}</i><b>{request.employee}<small>{request.team} · {request.id}</small></b></span><span>{request.leaveType}</span><span>{request.dateLabel}</span><span>{formatDuration(request)}{formatTimeRange(request) ? <small>{formatTimeRange(request)}</small> : null}</span><span><StatusPill status={request.status} /></span><ChevronRight size={15} /></button>)}
          {!requests.length ? <div className={styles.emptyState}><Search size={23} /><strong>No requests here</strong><span>Choose another status.</span></div> : null}
        </div>
        <RequestDetail profile={profile} request={selected} />
      </div>
    </section>
  );
}

function RequestDetail({ profile, request }: { profile: Profile; request: LeaveRequest }) {
  const canViewAttachments = profile.accessRole === "manager" || profile.accessRole === "hr";
  return <aside className={styles.detailPanel} aria-label={`${request.id} details`}><header><span className={styles.avatarOrange}>{request.initials}</span><span><small>{request.id}</small><h2>{request.employee}</h2><p>{request.team}</p></span><button type="button" aria-label="More record actions"><MoreHorizontal size={18} /></button></header><StatusPill status={request.status} /><dl><div><dt>Leave type</dt><dd>{request.leaveType}</dd></div><div><dt>When</dt><dd>{request.dateLabel}</dd></div><div><dt>Duration</dt><dd>{formatDurationWithTime(request)}</dd></div><div><dt>Approval</dt><dd>{request.approvalRequired ? request.manager : "Not required"}</dd></div></dl>{request.employeeNote !== "No note added." ? <section><span>{request.approvalRequired ? "Employee note" : "Private note"}</span><p>{request.employeeNote}</p><small><ShieldCheck size={13} /> {request.approvalRequired ? "Private to employee, approver and HR" : "Private to this person and HR"}</small></section> : null}{canViewAttachments ? <AttachmentList attachments={request.attachments} /> : null}{request.managerNote ? <section><span>Manager decision note</span><p>{request.managerNote}</p></section> : null}</aside>;
}

function AttachmentList({ attachments }: { attachments?: LeaveAttachment[] }) {
  if (!attachments?.length) return null;
  return <section className={styles.attachmentList}><span><Paperclip size={14} /> Supporting files · private</span>{attachments.map((attachment) => { const Icon = attachment.mimeType === "application/pdf" ? FileText : FileImage; return <a href={attachment.previewUrl} target="_blank" rel="noreferrer" key={attachment.id}><Icon size={17} /><span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.sizeBytes)}</small></span><Eye size={15} /></a>; })}<small><ShieldCheck size={13} /> Only managers and HR can open these files.</small></section>;
}

function ApprovalsView({ pending, selected, selectedId, note, requests, onNote, onSelect, onDecision }: { pending: LeaveRequest[]; selected: LeaveRequest; selectedId: string; note: string; requests: LeaveRequest[]; onNote: (note: string) => void; onSelect: (id: string) => void; onDecision: (status: "Approved" | "Declined") => void }) {
  return <div className={styles.approvalGrid}>
    <section className={`${styles.panel} ${styles.queue}`}><PanelHeader kicker={`${pending.length} waiting`} title="Decision queue" />{pending.length ? pending.map((request) => <button className={selectedId === request.id ? styles.queueActive : ""} type="button" onClick={() => onSelect(request.id)} key={request.id}><span className={styles.avatarSoft}>{request.initials}</span><span><strong>{request.employee}</strong><small>{request.leaveType} · {request.dateLabel}</small><i>Submitted {request.submittedAt.toLowerCase()}</i></span><ChevronRight size={16} /></button>) : <div className={styles.emptyState}><CheckCircle2 size={25} /><strong>Queue cleared</strong><span>Every request has a decision.</span></div>}</section>
    <section className={`${styles.panel} ${styles.approvalRecord}`}>
      <header className={styles.approvalHeader}><span className={styles.avatarOrange}>{selected.initials}</span><span><small>{selected.id}</small><h2>{selected.employee}</h2><p>{selected.team}</p></span><StatusPill status={selected.status} /></header>
      <div className={styles.factGrid}><article><CalendarDays size={17} /><span><small>When</small><strong>{selected.dateLabel}</strong></span></article><article><Clock3 size={17} /><span><small>Duration</small><strong>{formatDurationWithTime(selected)}</strong></span></article><article><ClipboardList size={17} /><span><small>Leave type</small><strong>{selected.leaveType}</strong></span></article></div>
      <div className={styles.privateNote}><span><ShieldCheck size={14} /> Employee note · private</span><p>{selected.employeeNote}</p></div>
      <AttachmentList attachments={selected.attachments} />
      <ApprovalCalendar selected={selected} requests={requests} />
      {selected.status === "Pending" ? <div className={styles.decisionBox}><label><span>Decision note <small>Required when declining</small></span><textarea rows={3} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Add context that will remain with this record." /></label><div><button className={styles.declineButton} type="button" onClick={() => onDecision("Declined")}><XCircle size={16} /> Decline</button><button className={styles.approveButton} type="button" onClick={() => onDecision("Approved")}><CheckCircle2 size={16} /> Approve leave</button></div></div> : <div className={styles.decisionRecorded}><CheckCircle2 size={19} /><span><strong>Decision recorded</strong><small>The employee view and leave register show {selected.status.toLowerCase()}.</small></span></div>}
    </section>
  </div>;
}

function ApprovalCalendar({ selected, requests }: { selected: LeaveRequest; requests: LeaveRequest[] }) {
  const days = getApprovalCalendarDays(selected);
  const rangeStart = days[0].iso;
  const rangeEnd = days[days.length - 1].iso;
  const teamLeave = requests.filter((request) => request.id !== selected.id && request.employee !== selected.employee && request.team === selected.team && request.status !== "Declined" && request.endDate >= rangeStart && request.startDate <= rangeEnd);
  const overlaps = teamLeave.filter((request) => requestsOverlap(selected, request));
  const visibleHolidays = demoCalendarHolidays.filter((holiday) => holiday.date >= rangeStart && holiday.date <= rangeEnd);

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
        <span><i className={styles.legendHoliday} />Public holiday</span>
      </div>
      <div className={styles.reviewCalendarViewport} tabIndex={0} aria-label="Scrollable coverage calendar">
        <div className={styles.reviewCalendar} role="grid" aria-label={`Team leave from ${formatDateRange(rangeStart, rangeEnd)}`}>
          <div className={styles.reviewCalendarWeek} role="row">
            {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((weekday) => <span role="columnheader" key={weekday}>{weekday}</span>)}
          </div>
          <div className={styles.reviewCalendarGrid}>
            {days.map((day, index) => {
              const isRequestedDay = day.iso >= selected.startDate && day.iso <= selected.endDate;
              const holiday = visibleHolidays.find((item) => item.date === day.iso);
              const otherLeave = teamLeave.filter((request) => day.iso >= request.startDate && day.iso <= request.endDate);
              return (
                <div className={`${styles.reviewCalendarDay} ${day.isWeekend ? styles.reviewCalendarWeekend : ""} ${isRequestedDay ? styles.reviewCalendarRequestedDay : ""}`} role="gridcell" key={day.iso}>
                  <time dateTime={day.iso}><b>{day.day}</b>{day.day === 1 || index === 0 ? <span>{day.month}</span> : null}</time>
                  {holiday ? <div className={styles.reviewHoliday}><CalendarDays size={13} /><span>{holiday.label}{holiday.isDemo ? <small>Demo</small> : null}</span></div> : null}
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
  return <section className={`${styles.panel} ${styles.calendarPanel}`}><div className={styles.calendarToolbar}><div><button type="button" aria-label="Previous month">‹</button><button type="button">Today</button><button type="button" aria-label="Next month">›</button></div><div className={styles.legend}><span><i className={styles.legendApproved} />Approved</span><span><i className={styles.legendPending} />Pending</span></div></div><div className={styles.calendarWeek}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => <span key={day}>{day}</span>)}</div><div className={styles.calendarGrid}>{days.map((day) => { const events = visible.filter((request) => day.iso >= request.startDate && day.iso <= request.endDate); return <div className={`${styles.calendarDay} ${day.inMonth ? "" : styles.calendarMuted}`} key={day.iso}><span>{day.day}</span>{events.slice(0, 3).map((request) => <article className={request.status === "Approved" ? styles.eventApproved : styles.eventPending} key={request.id}><i>{request.initials}</i><b>{request.employee}<small>Unavailable</small></b></article>)}</div>; })}</div><footer className={styles.calendarPrivacy}><ShieldCheck size={16} /><span><strong>Coverage without oversharing.</strong> Coworkers see availability dates, not personal leave notes.</span></footer></section>;
}
