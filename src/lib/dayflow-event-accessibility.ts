export const DAYFLOW_EVENT_SELECTOR = "[data-event-id][data-viewable='true']";

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
