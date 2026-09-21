import { isEventDeepEqual, type CalendarApp, type Event } from "@dayflow/core";

/** DayFlow's config synchroniser excludes events; update the display store only. */
export function syncCalendarEvents(app: Pick<CalendarApp, "getAllEvents" | "onEventDetailToggle" | "onMobileEventDetailToggle" | "applyEventsChanges">, events: Event[]) {
  const current = new Map(app.getAllEvents().map((event) => [event.id, event]));
  const nextIds = new Set(events.map((event) => event.id));
  const removed = [...current.keys()].filter((id) => !nextIds.has(id));
  const added = events.filter((event) => !current.has(event.id));
  const updated = events.filter((event) => current.has(event.id) && (
    !isEventDeepEqual(current.get(event.id)!, event)
    || JSON.stringify(current.get(event.id)!.meta) !== JSON.stringify(event.meta)
  )).map((event) => ({ id: event.id, updates: event }));
  if (removed.length || added.length || updated.length) {
    app.onEventDetailToggle(null);
    app.onMobileEventDetailToggle(null);
    app.applyEventsChanges({ delete: removed, add: added, update: updated }, false, "remote");
  }
}
