export const DAYFLOW_EVENT_SELECTOR = "[data-event-id][data-viewable='true']";
export const DAYFLOW_ACTIVE_VIEW_SELECTOR = ".df-view-switcher-btn[data-active='true']";
export const DAYFLOW_NAVIGATION_SELECTOR = ".df-calendar-nav-button";
export const DAYFLOW_SEARCH_TRIGGER_SELECTOR = ".df-icon-btn[title='Search']";

const DAYFLOW_SEARCH_DIALOG_SELECTOR = ".df-mobile-fullscreen";
const DAYFLOW_SEARCH_INPUT_SELECTOR = ".df-search-dialog-input";
const DAYFLOW_SEARCH_BACK_SELECTOR = ".df-search-dialog-back-btn";
const DAYFLOW_SEARCH_CLEAR_SELECTOR = ".df-search-dialog-input-clear";
const DAYFLOW_SEARCH_FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

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

function getDayFlowSearchDialogFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const dialog = target.closest<HTMLElement>(DAYFLOW_SEARCH_DIALOG_SELECTOR);
  return dialog?.querySelector(DAYFLOW_SEARCH_INPUT_SELECTOR) ? dialog : null;
}

export function makeDayFlowSearchAccessible(root: ParentNode) {
  root.querySelector<HTMLElement>(DAYFLOW_SEARCH_TRIGGER_SELECTOR)
    ?.setAttribute("aria-label", "Search calendar");

  const input = root.querySelector<HTMLElement>(DAYFLOW_SEARCH_INPUT_SELECTOR);
  if (!input) return;
  const dialog = input.closest<HTMLElement>(DAYFLOW_SEARCH_DIALOG_SELECTOR);
  if (!dialog) return;

  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Calendar search");
  input.setAttribute("aria-label", "Search calendar");
  dialog.querySelector<HTMLElement>(DAYFLOW_SEARCH_BACK_SELECTOR)
    ?.setAttribute("aria-label", "Close calendar search");
  dialog.querySelector<HTMLElement>(DAYFLOW_SEARCH_CLEAR_SELECTOR)
    ?.setAttribute("aria-label", "Clear calendar search");
}

export function isDayFlowSearchCloseTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(DAYFLOW_SEARCH_BACK_SELECTOR));
}

export function closeDayFlowSearchFromKeyboard(target: EventTarget | null, key: string) {
  if (key !== "Escape") return false;
  const dialog = getDayFlowSearchDialogFromTarget(target);
  const closeButton = dialog?.querySelector<HTMLElement>(DAYFLOW_SEARCH_BACK_SELECTOR);
  if (!closeButton) return false;
  closeButton.click();
  return true;
}

export function containDayFlowSearchFocus(target: EventTarget | null, key: string, shiftKey: boolean) {
  if (key !== "Tab" || !(target instanceof Element)) return false;
  const dialog = getDayFlowSearchDialogFromTarget(target);
  if (!dialog) return false;

  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(DAYFLOW_SEARCH_FOCUSABLE_SELECTOR));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (shiftKey && target === first && last) {
    last.focus({ preventScroll: true });
    return true;
  }
  if (!shiftKey && target === last && first) {
    first.focus({ preventScroll: true });
    return true;
  }
  return false;
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
