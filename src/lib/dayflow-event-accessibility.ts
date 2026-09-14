export const DAYFLOW_EVENT_SELECTOR = "[data-event-id][data-viewable='true']";
export const DAYFLOW_ACTIVE_VIEW_SELECTOR = ".df-view-switcher-btn[data-active='true']";
export const DAYFLOW_NAVIGATION_SELECTOR = ".df-calendar-nav-button";

const DAYFLOW_NAVIGATION_LABELS: Record<string, readonly [string, string]> = {
  Day: ["Previous day", "Next day"],
  Week: ["Previous week", "Next week"],
  Month: ["Previous month", "Next month"],
  Year: ["Previous year", "Next year"],
  Agenda: ["Previous 14 days", "Next 14 days"],
};

function describeEvent(element: HTMLElement) {
  const titledChild = element.querySelector<HTMLElement>("[title]");
  return titledChild?.getAttribute("title")?.trim()
    || element.textContent?.replace(/\s+/g, " ").trim()
    || "Calendar event";
}

function prepareEvent(element: HTMLElement) {
  if (!element.hasAttribute("role")) element.setAttribute("role", "button");
  if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
  if (!element.hasAttribute("aria-label")) element.setAttribute("aria-label", describeEvent(element));
  return element;
}

export function makeDayFlowEventsAccessible(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(DAYFLOW_EVENT_SELECTOR).forEach(prepareEvent);
}

export function makeDayFlowNavigationAccessible(root: ParentNode) {
  const activeView = root.querySelector<HTMLElement>(DAYFLOW_ACTIVE_VIEW_SELECTOR)?.textContent?.trim();
  const labels = activeView ? DAYFLOW_NAVIGATION_LABELS[activeView] : undefined;
  if (!labels) return;

  const [previousButton, nextButton] = Array.from(
    root.querySelectorAll<HTMLElement>(DAYFLOW_NAVIGATION_SELECTOR),
  );
  previousButton?.setAttribute("aria-label", labels[0]);
  nextButton?.setAttribute("aria-label", labels[1]);
}

export function getDayFlowEventFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const event = target.closest<HTMLElement>(DAYFLOW_EVENT_SELECTOR);
  return event ? prepareEvent(event) : null;
}

export function focusDayFlowEventFromTarget(target: EventTarget | null) {
  const event = getDayFlowEventFromTarget(target);
  event?.focus({ preventScroll: true });
  return event;
}

export function activateDayFlowEventFromKeyboard(target: EventTarget | null, key: string) {
  if (key !== "Enter" && key !== " ") return false;
  const event = getDayFlowEventFromTarget(target);
  if (!event) return false;
  event.click();
  return true;
}
