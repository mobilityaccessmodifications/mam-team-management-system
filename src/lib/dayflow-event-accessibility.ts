export const DAYFLOW_EVENT_SELECTOR = "[data-event-id][data-viewable='true']";
export const DAYFLOW_ACTIVE_VIEW_SELECTOR = ".df-view-switcher-btn[data-active='true']";
export const DAYFLOW_NAVIGATION_SELECTOR = ".df-calendar-nav-button";
export const DAYFLOW_SEARCH_TRIGGER_SELECTOR = ".df-icon-btn[title='Search']";

const DAYFLOW_VIEW_SWITCHER_SELECTOR = ".df-view-switcher";
const DAYFLOW_VIEW_SELECTOR = ".df-view-switcher-btn";
const DAYFLOW_SEARCH_DIALOG_SELECTOR = ".df-mobile-fullscreen";
const DAYFLOW_SEARCH_INPUT_SELECTOR = ".df-search-dialog-input";
const DAYFLOW_SEARCH_BACK_SELECTOR = ".df-search-dialog-back-btn";
const DAYFLOW_SEARCH_CLEAR_SELECTOR = ".df-search-dialog-input-clear";
const DAYFLOW_SEARCH_RESULT_SELECTOR = ".df-search-results-event";
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

export function makeDayFlowViewSwitcherAccessible(root: ParentNode) {
  const switcher = root.querySelector<HTMLElement>(DAYFLOW_VIEW_SWITCHER_SELECTOR);
  switcher?.setAttribute("role", "group");
  switcher?.setAttribute("aria-label", "Calendar view");
  root.querySelectorAll<HTMLElement>(DAYFLOW_VIEW_SELECTOR).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.getAttribute("data-active") === "true"));
  });
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

function compactText(element: Element | null | undefined) {
  return element?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function prepareSearchResult(element: HTMLElement) {
  const group = element.closest<HTMLElement>(".df-search-results-group");
  const title = compactText(element.querySelector(".df-search-results-event-title"));
  const date = compactText(group?.querySelector(".df-search-results-date-header"));
  const time = compactText(element.querySelector(".df-search-results-event-time"));
  if (!element.hasAttribute("role")) element.setAttribute("role", "button");
  if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
  if (!element.hasAttribute("aria-label")) {
    element.setAttribute("aria-label", [title, date, time].filter(Boolean).join(", ") || "Calendar search result");
  }
  return element;
}

export function makeDayFlowSearchAccessible(root: ParentNode) {
  root.querySelector<HTMLElement>(DAYFLOW_SEARCH_TRIGGER_SELECTOR)
    ?.setAttribute("aria-label", "Search calendar");
  root.querySelectorAll<HTMLElement>(DAYFLOW_SEARCH_RESULT_SELECTOR).forEach(prepareSearchResult);

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

function getDayFlowSearchResultFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const result = target.closest<HTMLElement>(DAYFLOW_SEARCH_RESULT_SELECTOR);
  return result ? prepareSearchResult(result) : null;
}

export function activateDayFlowSearchResultFromKeyboard(target: EventTarget | null, key: string) {
  if (key !== "Enter" && key !== " ") return false;
  const result = getDayFlowSearchResultFromTarget(target);
  if (!result) return false;
  result.click();
  return true;
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
