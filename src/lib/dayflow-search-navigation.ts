type DayFlowSearchResultAction = {
  closeSearch: () => void;
  defaultAction: () => void;
  source: "desktop" | "mobile";
};

type FrameScheduler = (callback: () => void) => unknown;

const scheduleNextFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback);

export function navigateFromDayFlowSearchResult(
  { closeSearch, defaultAction, source }: DayFlowSearchResultAction,
  schedule: FrameScheduler = scheduleNextFrame,
) {
  if (source === "desktop") {
    defaultAction();
    return;
  }

  closeSearch();
  schedule(defaultAction);
}
