"use client";

import "@dayflow/core/dist/styles.components.css";

import { CalendarDays, CheckCircle2, Clock3, Gift, Search, ShieldCheck, WalletCards, X } from "lucide-react";
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
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Temporal } from "temporal-polyfill";

import type { BirthdayCalendarEntry, CheckInCalendarEntry, SubscriptionReviewCalendarEntry } from "@/app/leave/actions";
import styles from "@/components/team-calendar.module.css";

type CalendarLeaveRequest = {
  id: string;
  employee: string;
  initials: string;
  team: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  status: "Pending" | "Approved" | "Declined" | "Cancelled";
};

type EventKind = "approved" | "pending" | "birthday" | "check-in" | "subscription";
type MAMEventMeta = { kind: EventKind; subject: string; detail: string; dateLabel: string; priority: number };

type TeamCalendarProps = {
  birthdays: BirthdayCalendarEntry[];
  checkIns: CheckInCalendarEntry[];
  requests: CalendarLeaveRequest[];
  subscriptionReviews: SubscriptionReviewCalendarEntry[];
  /** An employee-responsible calendar must never include team data. */
  reviewOnly: boolean;
  loading: boolean;
};

const timeZone = "Australia/Melbourne";
const subscribeToClient = () => () => undefined;
const views = [createDayView(), createWeekView(), createMonthView(), createYearView(), createAgendaView()];

const calendars: CalendarType[] = [
  { id: "approved", name: "Approved leave", icon: "✓", isVisible: true, readOnly: true, colors: { eventColor: "#e9f6f0", eventSelectedColor: "#237657", lineColor: "#237657", textColor: "#164d3b" } },
  { id: "pending", name: "Pending leave", icon: "◷", isVisible: true, readOnly: true, colors: { eventColor: "#fff1e8", eventSelectedColor: "#ef6a25", lineColor: "#ef6a25", textColor: "#9a3d10" } },
  { id: "birthday", name: "Birthdays", icon: "◈", isVisible: true, readOnly: true, colors: { eventColor: "#e9f5fb", eventSelectedColor: "#1684ad", lineColor: "#1684ad", textColor: "#075978" } },
  { id: "check-in", name: "Check-ins", icon: "CI", isVisible: true, readOnly: true, colors: { eventColor: "#f2edfb", eventSelectedColor: "#7454a2", lineColor: "#7454a2", textColor: "#523a76" } },
  { id: "subscription", name: "Subscription reviews", icon: "$", isVisible: true, readOnly: true, colors: { eventColor: "#fff7df", eventSelectedColor: "#b77914", lineColor: "#b77914", textColor: "#744d0f" } },
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

function milestoneLabel(milestone: CheckInCalendarEntry["milestone"]) {
  if (milestone === "2_week") return "2-week check-in";
  if (milestone === "1_month") return "1-month check-in";
  if (milestone === "3_month") return "3-month check-in";
  return "5-month check-in";
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
  years: number[],
) {
  const leave = requests.filter((request) => request.status === "Approved" || request.status === "Pending").map((request) => {
    const kind: EventKind = request.status === "Approved" ? "approved" : "pending";
    const times = request.startTime && request.endTime ? ` · ${request.startTime.slice(0, 5)}–${request.endTime.slice(0, 5)}` : "";
    return createMAMEvent({
      id: `leave:${request.id}`,
      title: `${request.employee} · ${request.leaveType}`,
      startDate: request.startDate,
      endDate: request.endDate,
      startTime: request.startTime,
      endTime: request.endTime,
      calendarId: kind,
      meta: { kind, subject: request.employee, detail: `${request.status} · ${request.leaveType}${request.team ? ` · ${request.team}` : ""}`, dateLabel: `${formatDateRange(request.startDate, request.endDate)}${times}`, priority: kind === "pending" ? 4 : 5 },
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
  return [...birthday, ...checkIn, ...subscriptions, ...leave];
}

function EventDetail({ event, onClose }: EventDetailContentProps) {
  const meta = eventMeta(event);
  const icon = meta.kind === "birthday" ? <Gift size={18} /> : meta.kind === "check-in" ? <CheckCircle2 size={18} /> : meta.kind === "subscription" ? <WalletCards size={18} /> : <CalendarDays size={18} />;
  return (
    <div className={styles.eventDetail}>
      <div className={styles.eventDetailHeader}>
        <span className={styles.eventDetailIcon} data-kind={meta.kind}>{icon}</span>
        <div><span>{meta.detail}</span><h3>{meta.subject}</h3></div>
        <button type="button" onClick={onClose} aria-label="Close event details"><X size={18} /></button>
      </div>
      <div className={styles.eventDetailDate}><Clock3 size={16} /><span>{meta.dateLabel}</span></div>
      <p><ShieldCheck size={15} />Private leave notes are not shown in the calendar.</p>
    </div>
  );
}

function MobileEventDetail({ draftEvent, isOpen, onClose }: MobileEventProps) {
  if (!isOpen || !draftEvent) return null;

  return (
    <div className={styles.mobileDetailBackdrop} onClick={onClose} role="presentation">
      <div
        aria-label="Event details"
        aria-modal="true"
        className={styles.mobileDetailSheet}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
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
    </div>
  );
}

function TeamCalendarClient({ birthdays, checkIns, requests, subscriptionReviews, reviewOnly, loading }: TeamCalendarProps) {
  const year = new Date().getFullYear();
  const [visibleYears, setVisibleYears] = useState([year - 1, year, year + 1]);
  const events = useMemo(() => buildEvents(birthdays, checkIns, requests, subscriptionReviews, visibleYears), [birthdays, checkIns, requests, subscriptionReviews, visibleYears]);
  const version = useMemo(() => `${reviewOnly}|${events.map((event) => `${event.id}:${event.start}:${event.end}`).join("|")}`, [events, reviewOnly]);
  const onVisibleRangeChange = useCallback((start: Date, end: Date) => {
    const next = Array.from({ length: end.getFullYear() - start.getFullYear() + 3 }, (_, index) => start.getFullYear() - 1 + index);
    setVisibleYears((current) => current.join(",") === next.join(",") ? current : next);
  }, []);
  const calendar = useCalendarApp({
    views,
    events,
    calendars: reviewOnly ? calendars.filter((item) => item.id === "subscription") : calendars,
    defaultCalendar: reviewOnly ? "subscription" : "approved",
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
    callbacks: { onVisibleRangeChange },
    theme: { mode: "light", colors: { background: "#fffdfa", foreground: "#20302c", text: "#20302c", border: "#d7e0dc", card: "#ffffff", cardForeground: "#20302c", hover: "#f5f7f5", muted: "#eef2ef", mutedForeground: "#697873", primary: "#ef6a25", primaryForeground: "#ffffff", ring: "#ef6a25" } },
  }, version);
  const customSearch = useCallback(({ keyword, events: items }: { keyword: string; events: CalendarSearchEvent[] }) => {
    const query = keyword.trim().toLowerCase();
    return query ? items.filter((event) => `${event.title} ${event.description ?? ""}`.toLowerCase().includes(query)) : items;
  }, []);

  return (
    <section className={styles.calendarSection} aria-label={reviewOnly ? "Subscription review calendar" : "Team calendar"}>
      <header className={styles.intro}>
        <div><span>{reviewOnly ? "YOUR REVIEWS" : "TEAM SCHEDULE"}</span><h1>{reviewOnly ? "Subscription calendar" : "Team calendar"}</h1><p>{reviewOnly ? "Your assigned paid-subscription reviews." : "Leave, birthdays and manager check-ins in one calendar."}</p></div>
        <div className={styles.privacy}><ShieldCheck size={15} />{reviewOnly ? "Only your reviews" : "Private notes hidden"}</div>
      </header>
      <div className={styles.calendarFrame} aria-busy={loading}>
        <DayFlowCalendar
          calendar={calendar}
          eventDetailContent={(props) => <EventDetail {...props} />}
          mobileEventDetail={(props) => <MobileEventDetail {...props} />}
          search={{ customSearch, debounceDelay: 120, emptyText: "No matching events", timeFormat: "12h" }}
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
