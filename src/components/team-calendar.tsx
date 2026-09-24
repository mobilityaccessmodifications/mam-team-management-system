"use client";

import "@dayflow/core/dist/styles.components.css";

import { CalendarDays, CheckCircle2, Clock3, FileSpreadsheet, Flag, Gift, Search, WalletCards, X } from "lucide-react";
import {
  DayFlowCalendar,
  ViewType,
  createAgendaView,
  createAllDayEvent,
  createDayView,
  createEvent,
  createMonthView,
  createWeekView,
  createYearView,
  useCalendarApp,
  type CalendarSearchEvent,
  type CalendarType,
  type Event,
  type EventDetailContentProps,
  type MobileEventProps,
} from "@dayflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Temporal } from "temporal-polyfill";

import type { BirthdayCalendarEntry, CheckInCalendarEntry, PayrollBalanceReminderCalendarEntry, SubscriptionReviewCalendarEntry } from "@/app/leave/actions";
import { CalendarFilters } from "@/components/calendar-filters";
import { calendarEventIsVisible, calendarTeamOptions } from "@/lib/calendar-filters";
import { syncCalendarEvents } from "@/lib/sync-calendar-events";
import styles from "@/components/team-calendar.module.css";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  DAYFLOW_SEARCH_TRIGGER_SELECTOR,
  activateDayFlowEventFromKeyboard,
  activateDayFlowSearchResultFromKeyboard,
  closeDayFlowSearchFromKeyboard,
  containDayFlowSearchFocus,
  focusDayFlowEventFromTarget,
  makeDayFlowEventsAccessible,
  makeDayFlowNavigationAccessible,
  makeDayFlowSearchAccessible,
  makeDayFlowViewSwitcherAccessible,
  restoreDayFlowDesktopSearchFocusAfterClear,
} from "@/lib/dayflow-event-accessibility";
import { navigateFromDayFlowSearchResult } from "@/lib/dayflow-search-navigation";
import { BALANCE_PENDING_STATUS } from "@/lib/leave-priority";
import { getVictorianPublicHolidays } from "@/lib/victorian-public-holidays";

type CalendarLeaveRequest = {
  id: string;
  employee: string;
  initials: string;
  team: string;
  position?: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  days: number;
  hours?: number;
  status: "Pending" | "Approved" | "Declined" | "Cancelled" | typeof BALANCE_PENDING_STATUS;
};

type EventKind = "approved" | "pending" | "balance-pending" | "birthday" | "check-in" | "subscription" | "payroll-balance" | "public-holiday";
type MAMEventMeta = { kind: EventKind; subject: string; detail: string; identity?: string; leaveType?: string; dateLabel: string; priority: number; team?: string; duration?: { days: number; hours?: number } };

type TeamCalendarProps = {
  birthdays: BirthdayCalendarEntry[];
  checkIns: CheckInCalendarEntry[];
  requests: CalendarLeaveRequest[];
  subscriptionReviews: SubscriptionReviewCalendarEntry[];
  payrollBalanceReminders: PayrollBalanceReminderCalendarEntry[];
  showSubscriptionReviews: boolean;
  showPayrollBalanceReminders: boolean;
  /** An employee-responsible calendar must never include team data. */
  reviewOnly: boolean;
  loading: boolean;
};

const timeZone = "Australia/Melbourne";
const subscribeToClient = () => () => undefined;
const views = [createDayView(), createWeekView(), createMonthView(), createYearView(), createAgendaView()];

const calendars: CalendarType[] = [
  { id: "balance-pending", name: "Approved – pending leave balance", icon: "◷", isVisible: true, readOnly: true, colors: { eventColor: "#fff2b3", eventSelectedColor: "#a17b00", lineColor: "#c79a12", textColor: "#604800" } },
  { id: "approved", name: "Approved leave", icon: "✓", isVisible: true, readOnly: true, colors: { eventColor: "#e9f6f0", eventSelectedColor: "#237657", lineColor: "#237657", textColor: "#164d3b" } },
  { id: "pending", name: "Pending leave", icon: "◷", isVisible: true, readOnly: true, colors: { eventColor: "#fff1e8", eventSelectedColor: "#ef6a25", lineColor: "#ef6a25", textColor: "#9a3d10" } },
  { id: "public-holiday", name: "Victorian public holidays", icon: "VIC", isVisible: true, readOnly: true, colors: { eventColor: "#edf1f8", eventSelectedColor: "#50658a", lineColor: "#61779d", textColor: "#344766" } },
  { id: "birthday", name: "Birthdays", icon: "◈", isVisible: true, readOnly: true, colors: { eventColor: "#e9f5fb", eventSelectedColor: "#1684ad", lineColor: "#1684ad", textColor: "#075978" } },
  { id: "check-in", name: "Check-ins", icon: "CI", isVisible: true, readOnly: true, colors: { eventColor: "#f2edfb", eventSelectedColor: "#7454a2", lineColor: "#7454a2", textColor: "#523a76" } },
  { id: "subscription", name: "Subscription reviews", icon: "$", isVisible: true, readOnly: true, colors: { eventColor: "#fff7df", eventSelectedColor: "#b77914", lineColor: "#b77914", textColor: "#744d0f" } },
  { id: "payroll-balance", name: "Payroll balance updates", icon: "↑", isVisible: true, readOnly: true, colors: { eventColor: "#eef8f4", eventSelectedColor: "#26745a", lineColor: "#26745a", textColor: "#19513f" } },
];

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function birthdayDate(year: number, birthday: BirthdayCalendarEntry) {
  const day = birthday.month === 2 && birthday.day === 29 && !isLeapYear(year) ? 28 : birthday.day;
  return `${year}-${String(birthday.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(`${date}T00:00:00+10:00`));
}

function formatDateRange(start: string, end: string) {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

function formatLeaveDuration({ days, hours }: NonNullable<MAMEventMeta["duration"]>) {
  const weekdays = `${days} ${days === 1 ? "weekday" : "weekdays"}`;
  return hours == null ? weekdays : `${hours} ${hours === 1 ? "hour" : "hours"} · ${weekdays}`;
}

function milestoneLabel(milestone: CheckInCalendarEntry["milestone"]) {
  if (milestone === "2_week") return "2-week check-in";
  if (milestone === "1_month") return "1-month check-in";
  if (milestone === "2_month") return "2-month stay interview";
  if (milestone === "3_month") return "3-month check-in";
  if (milestone === "6_month") return "6-month check-in";
  return "5-Month No-Surprises Review";
}

function createMAMEvent({ id, title, startDate, endDate = startDate, startTime, endTime, calendarId, meta }: {
  id: string;
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  calendarId: EventKind;
  meta: MAMEventMeta;
}) {
  if (startTime && endTime) {
    return createEvent({
      id,
      title,
      description: meta.detail,
      start: Temporal.PlainDateTime.from(`${startDate}T${startTime.slice(0, 5)}`),
      end: Temporal.PlainDateTime.from(`${endDate}T${endTime.slice(0, 5)}`),
      calendarId,
      meta,
    });
  }
  return createAllDayEvent({
    id,
    title,
    description: meta.detail,
    start: Temporal.PlainDate.from(startDate),
    end: Temporal.PlainDate.from(endDate),
    calendarId,
    meta,
  });
}

function eventMeta(event: Event) {
  return event.meta as MAMEventMeta;
}

function buildEvents(
  birthdays: BirthdayCalendarEntry[],
  checkIns: CheckInCalendarEntry[],
  requests: CalendarLeaveRequest[],
  reviews: SubscriptionReviewCalendarEntry[],
  payrollReminders: PayrollBalanceReminderCalendarEntry[],
  years: number[],
) {
  const leave = requests.filter((request) => request.status === "Approved" || request.status === "Pending" || request.status === BALANCE_PENDING_STATUS).map((request) => {
    const kind: EventKind = request.status === BALANCE_PENDING_STATUS ? "balance-pending" : request.status === "Approved" ? "approved" : "pending";
    const times = request.startTime && request.endTime ? ` · ${request.startTime.slice(0, 5)}–${request.endTime.slice(0, 5)}` : "";
    return createMAMEvent({
      id: `leave:${request.id}`,
      title: `${request.employee} · ${request.leaveType}`,
      startDate: request.startDate,
      endDate: request.endDate,
      startTime: request.startTime,
      endTime: request.endTime,
      calendarId: kind,
      meta: { kind, team: request.team, subject: request.employee, detail: `${request.status} · ${request.leaveType}${request.team ? ` · ${request.team}` : ""}`, identity: Array.from(new Set([request.position, ...request.team.split(" · ").reverse()].filter(Boolean))).join(" · "), leaveType: request.leaveType, dateLabel: `${formatDateRange(request.startDate, request.endDate)}${times}`, duration: { days: request.days, hours: request.hours }, priority: kind === "pending" ? 4 : 5 },
    });
  });

  const uniqueCheckIns = Array.from(new Map(checkIns.map((entry) => [`${entry.personId}:${entry.milestone}:${entry.dueDate}`, entry])).values());
  const checkIn = uniqueCheckIns.map((entry) => createMAMEvent({
    id: `check-in:${entry.personId}:${entry.milestone}:${entry.dueDate}`,
    title: `${entry.employee} · ${milestoneLabel(entry.milestone)}`,
    startDate: entry.dueDate,
    calendarId: "check-in",
    meta: { kind: "check-in", subject: entry.employee, detail: `${milestoneLabel(entry.milestone)}${entry.sequence === "final" ? " · Final reminder" : ""}`, dateLabel: formatDate(entry.dueDate), priority: 2 },
  }));
  const subscriptions = reviews.map((entry) => createMAMEvent({
    id: `subscription:${entry.subscriptionId}:${entry.dueDate}`,
    title: `${entry.serviceName} · Subscription review`,
    startDate: entry.dueDate,
    calendarId: "subscription",
    meta: { kind: "subscription", subject: entry.serviceName, detail: "Quarterly paid subscription review", dateLabel: formatDate(entry.dueDate), priority: 3 },
  }));
  const payroll = payrollReminders.map((entry) => createMAMEvent({
    id: entry.reminderId,
    title: "Update payroll leave balances",
    startDate: entry.dueDate,
    calendarId: "payroll-balance",
    meta: { kind: "payroll-balance", subject: "MAM and Equipsy", detail: "Monthly CSV / Excel leave balance import", dateLabel: formatDate(entry.dueDate), priority: 3 },
  }));
  const birthday = years.flatMap((year) => birthdays.map((entry, index) => {
    const date = birthdayDate(year, entry);
    return createMAMEvent({
      id: `birthday:${entry.employee}:${entry.month}:${entry.day}:${year}:${index}`,
      title: `${entry.employee} · Birthday`,
      startDate: date,
      calendarId: "birthday",
      meta: { kind: "birthday", subject: entry.employee, detail: "Birthday", dateLabel: formatDate(date), priority: 1 },
    });
  }));
  const publicHolidays = getVictorianPublicHolidays(years).map((holiday) => createMAMEvent({
    id: `public-holiday:${holiday.date}`,
    title: holiday.name,
    startDate: holiday.date,
    calendarId: "public-holiday",
    meta: { kind: "public-holiday", subject: holiday.name, detail: "Victorian public holiday", dateLabel: formatDate(holiday.date), priority: 0 },
  }));
  return [...publicHolidays, ...birthday, ...checkIn, ...subscriptions, ...payroll, ...leave];
}

function EventDetail({ event, onClose }: EventDetailContentProps) {
  const meta = eventMeta(event);
  const icon = meta.kind === "public-holiday" ? <Flag size={18} /> : meta.kind === "birthday" ? <Gift size={18} /> : meta.kind === "check-in" ? <CheckCircle2 size={18} /> : meta.kind === "subscription" ? <WalletCards size={18} /> : meta.kind === "payroll-balance" ? <FileSpreadsheet size={18} /> : <CalendarDays size={18} />;
  return (
    <div className={styles.eventDetail}>
      <div className={styles.eventDetailHeader}>
        <span className={styles.eventDetailIcon} data-kind={meta.kind}>{icon}</span>
        <div><span>{meta.identity ?? meta.detail}</span><h3>{meta.subject}</h3></div>
        <button type="button" onClick={onClose} aria-label="Close event details"><X size={18} /></button>
      </div>
      {meta.leaveType ? <div className={styles.eventDetailDate}><CalendarDays size={16} /><span>{meta.leaveType}</span></div> : null}
      <div className={styles.eventDetailDate}><Clock3 size={16} /><span>{meta.dateLabel}</span></div>
      {meta.duration ? <div className={styles.eventDetailDate}><Clock3 size={16} aria-hidden="true" /><span>Duration: {formatLeaveDuration(meta.duration)}</span></div> : null}
    </div>
  );
}

function MobileEventDetail({ draftEvent, isOpen, onClose }: MobileEventProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(isOpen && Boolean(draftEvent), dialogRef, null, onClose);
  if (!isOpen || !draftEvent) return null;

  return (
    <ModalBackdrop className={styles.mobileDetailBackdrop} onClick={onClose} role="presentation">
      <div
        aria-label="Event details"
        aria-modal="true"
        className={styles.mobileDetailSheet}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        ref={dialogRef}
      >
        <span aria-hidden="true" className={styles.mobileDetailHandle} />
        <EventDetail
          app={undefined}
          event={draftEvent}
          isAllDay={Boolean(draftEvent.allDay)}
          onClose={onClose}
          onEventDelete={() => undefined}
          onEventUpdate={() => undefined}
        />
      </div>
    </ModalBackdrop>
  );
}

function TeamCalendarClient({ birthdays, checkIns, requests, subscriptionReviews, payrollBalanceReminders, showSubscriptionReviews, showPayrollBalanceReminders, reviewOnly, loading }: TeamCalendarProps) {
  const [filterHost, setFilterHost] = useState<HTMLElement | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<string[]>([]);
  const [hiddenTeams, setHiddenTeams] = useState<string[]>([]);
  const teams = useMemo(() => calendarTeamOptions(requests), [requests]);
  const year = new Date().getFullYear();
  const calendarFrameRef = useRef<HTMLDivElement>(null);
  const [visibleYears, setVisibleYears] = useState([year - 1, year, year + 1]);
  const events = useMemo(() => buildEvents(birthdays, checkIns, requests, subscriptionReviews, payrollBalanceReminders, visibleYears), [birthdays, checkIns, requests, subscriptionReviews, payrollBalanceReminders, visibleYears]);
  // Keep the calendar instance stable while its event data syncs. Recreating it
  // whenever visibleYears changes resets the active view back to Month (which
  // made Year appear to do nothing).
  const visibleCalendars = useMemo(() => calendars.filter((item) => {
    if (item.id === "public-holiday") return true;
    if (item.id === "subscription") return showSubscriptionReviews;
    if (item.id === "payroll-balance") return showPayrollBalanceReminders;
    return !reviewOnly;
  }), [reviewOnly, showPayrollBalanceReminders, showSubscriptionReviews]);
  const filteredEvents = useMemo(() => events.filter((event) => {
    const meta = eventMeta(event);
    return visibleCalendars.some((kind) => kind.id === meta.kind)
      && calendarEventIsVisible(meta.kind, meta.team, hiddenKinds, hiddenTeams);
  }), [events, visibleCalendars, hiddenKinds, hiddenTeams]);
  const defaultCalendar = visibleCalendars[0]?.id ?? "approved";
  const calendarVersion = `${reviewOnly ? "limited" : "team"}:${visibleCalendars.map((item) => item.id).join(",")}`;
  const onVisibleRangeChange = useCallback((start: Date, end: Date) => {
    const next = Array.from({ length: end.getFullYear() - start.getFullYear() + 3 }, (_, index) => start.getFullYear() - 1 + index);
    setVisibleYears((current) => current.join(",") === next.join(",") ? current : next);
  }, []);
  const calendarAppRef = useRef<ReturnType<typeof useCalendarApp>["app"] | null>(null);
  const onMoreEventsClick = useCallback((date: Date) => {
    const app = calendarAppRef.current;
    if (!app) return;
    app.setCurrentDate(date);
    app.changeView(ViewType.DAY);
  }, []);
  const calendar = useCalendarApp({
    views,
    events: filteredEvents,
    calendars: visibleCalendars,
    defaultCalendar,
    defaultView: ViewType.MONTH,
    initialDate: new Date(),
    switcherMode: "buttons",
    locale: "en-AU",
    timeZone,
    timeFormat: "12h",
    useCalendarHeader: true,
    useEventDetailPanel: true,
    eventDetailTrigger: "click",
    readOnly: { draggable: false, viewable: true },
    allDaySortComparator: (first, second) => eventMeta(first).priority - eventMeta(second).priority,
    callbacks: { onVisibleRangeChange, onMoreEventsClick },
    theme: { mode: "light", colors: { background: "#ffffff", foreground: "#182421", text: "#182421", border: "#d8dfdc", card: "#ffffff", cardForeground: "#182421", hover: "#eef2f0", muted: "#eef2f0", mutedForeground: "#64736e", primary: "#c34d14", primaryForeground: "#ffffff", ring: "#ef6a24" } },
  }, calendarVersion);
  useEffect(() => {
    syncCalendarEvents(calendar.app, filteredEvents);
  }, [calendar.app, filteredEvents]);
  useEffect(() => {
    calendarAppRef.current = calendar.app;
    return () => {
      if (calendarAppRef.current === calendar.app) calendarAppRef.current = null;
    };
  }, [calendar.app]);
  useEffect(() => {
    const frame = calendarFrameRef.current;
    if (!frame) return;
    const refreshCalendarSemantics = () => {
      setFilterHost(frame.querySelector<HTMLElement>(".df-header-right"));
      makeDayFlowEventsAccessible(frame);
      makeDayFlowNavigationAccessible(frame);
      makeDayFlowSearchAccessible(document);
      makeDayFlowViewSwitcherAccessible(frame);
    };
    refreshCalendarSemantics();
    const observer = new MutationObserver(refreshCalendarSemantics);
    observer.observe(frame, {
      attributes: true,
      attributeFilter: ["data-active"],
      childList: true,
      subtree: true,
    });
    const restoreSearchTriggerFocus = () => {
      const searchTrigger = frame.querySelector<HTMLElement>(DAYFLOW_SEARCH_TRIGGER_SELECTOR);
      window.requestAnimationFrame(() => searchTrigger?.focus({ preventScroll: true }));
    };
    let searchWasOpen = Boolean(document.querySelector(".df-mobile-fullscreen .df-search-dialog-input"));
    const refreshSearchSemantics = () => {
      const searchIsOpen = Boolean(document.querySelector(".df-mobile-fullscreen .df-search-dialog-input"));
      makeDayFlowSearchAccessible(document);
      if (searchWasOpen && !searchIsOpen) restoreSearchTriggerFocus();
      searchWasOpen = searchIsOpen;
    };
    const searchObserver = new MutationObserver(refreshSearchSemantics);
    searchObserver.observe(document.body, { childList: true, subtree: true });

    const handleSearchKeyDown = (event: KeyboardEvent) => {
      if (activateDayFlowSearchResultFromKeyboard(event.target, event.key)) {
        event.preventDefault();
        return;
      }
      if (containDayFlowSearchFocus(event.target, event.key, event.shiftKey)) {
        event.preventDefault();
        return;
      }
      if (closeDayFlowSearchFromKeyboard(event.target, event.key)) event.preventDefault();
    };
    const handleSearchClick = (event: MouseEvent) => {
      restoreDayFlowDesktopSearchFocusAfterClear(event.target);
    };
    document.addEventListener("click", handleSearchClick, true);
    document.addEventListener("keydown", handleSearchKeyDown, true);
    return () => {
      observer.disconnect();
      searchObserver.disconnect();
      document.removeEventListener("click", handleSearchClick, true);
      document.removeEventListener("keydown", handleSearchKeyDown, true);
    };
  }, []);
  const customSearch = useCallback(({ keyword, events: items }: { keyword: string; events: CalendarSearchEvent[] }) => {
    const query = keyword.trim().toLowerCase();
    return query ? items.filter((event) => `${event.title} ${event.description ?? ""}`.toLowerCase().includes(query)) : items;
  }, []);

  return (
    <section className={styles.calendarSection} aria-label={reviewOnly ? "Personal operations reminders" : "Team calendar"}>
      {filterHost ? createPortal(<CalendarFilters kinds={visibleCalendars} teams={teams} hiddenKinds={hiddenKinds} hiddenTeams={hiddenTeams}
        onKind={(id) => setHiddenKinds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
        onTeam={(team) => setHiddenTeams((current) => current.includes(team) ? current.filter((item) => item !== team) : [...current, team])}
        onReset={() => { setHiddenKinds([]); setHiddenTeams([]); }} />, filterHost) : null}
      <div
        className={styles.calendarFrame}
        aria-busy={loading}
        ref={calendarFrameRef}
        onPointerDownCapture={(event) => focusDayFlowEventFromTarget(event.target)}
        onKeyDownCapture={(event) => {
          if (activateDayFlowEventFromKeyboard(event.target, event.key)) event.preventDefault();
        }}
      >
        <DayFlowCalendar
          calendar={calendar}
          eventDetailContent={(props) => <EventDetail {...props} />}
          mobileEventDetail={(props) => <MobileEventDetail {...props} />}
          search={{ customSearch, debounceDelay: 120, emptyText: "No matching events", onResultClick: navigateFromDayFlowSearchResult, timeFormat: "12h" }}
        />
        {loading ? <div className={styles.loading} role="status"><span /><strong>Refreshing calendar…</strong></div> : null}
      </div>
      <div className={styles.mobileHint}><Search size={15} />Use search or Agenda for a compact list.</div>
    </section>
  );
}

export function TeamCalendar(props: TeamCalendarProps) {
  const isClient = useSyncExternalStore(subscribeToClient, () => true, () => false);
  if (!isClient) return <section className={styles.calendarSection} aria-label="Loading calendar"><div className={styles.calendarPlaceholder}><CalendarDays size={23} /><strong>Loading calendar…</strong></div></section>;
  return <TeamCalendarClient {...props} />;
}
