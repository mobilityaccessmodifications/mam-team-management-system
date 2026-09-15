"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./motion-tabs.module.css";

export type MotionTabOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
  hidden?: boolean;
};

type MotionTabsOrientation = "horizontal" | "vertical" | "responsive";

const wideDesktopQuery = "(min-width: 1320px)";

function subscribeToWideDesktop(callback: () => void) {
  const media = window.matchMedia(wideDesktopQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function getWideDesktopSnapshot() {
  return window.matchMedia(wideDesktopQuery).matches;
}

function getWideDesktopServerSnapshot() {
  return false;
}

export function MotionTabs<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className = "",
  orientation = "horizontal",
  panelId,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: MotionTabOption<T>[];
  ariaLabel: string;
  className?: string;
  orientation?: MotionTabsOrientation;
  panelId?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const isWideDesktop = useSyncExternalStore(
    subscribeToWideDesktop,
    getWideDesktopSnapshot,
    getWideDesktopServerSnapshot,
  );
  const resolvedOrientation = orientation === "responsive"
    ? isWideDesktop ? "vertical" : "horizontal"
    : orientation;
  const visibleOptions = options.filter((option) => !option.hidden);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tabList = root;

    function revealActiveTab() {
      const active = tabList.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) return;

      if (resolvedOrientation === "vertical") {
        const top = active.offsetTop;
        const bottom = top + active.offsetHeight;
        if (top < tabList.scrollTop || bottom > tabList.scrollTop + tabList.clientHeight) {
          tabList.scrollTo({
            top: Math.max(0, top - (tabList.clientHeight - active.offsetHeight) / 2),
            behavior: "auto",
          });
        }
        return;
      }

      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      if (left < tabList.scrollLeft || right > tabList.scrollLeft + tabList.clientWidth) {
        tabList.scrollTo({
          left: Math.max(0, left - (tabList.clientWidth - active.offsetWidth) / 2),
          behavior: "auto",
        });
      }
    }

    revealActiveTab();
    const resizeObserver = new ResizeObserver(revealActiveTab);
    resizeObserver.observe(tabList);
    return () => resizeObserver.disconnect();
  }, [resolvedOrientation, value]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const previousKey = resolvedOrientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const nextKey = resolvedOrientation === "vertical" ? "ArrowDown" : "ArrowRight";
    let nextIndex: number | undefined;

    if (event.key === previousKey) nextIndex = (index - 1 + visibleOptions.length) % visibleOptions.length;
    if (event.key === nextKey) nextIndex = (index + 1) % visibleOptions.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visibleOptions.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextOption = visibleOptions[nextIndex];
    setKeyboardNavigation(true);
    onValueChange(nextOption.value);
    requestAnimationFrame(() => {
      tabRefs.current.get(nextOption.value)?.focus();
      requestAnimationFrame(() => setKeyboardNavigation(false));
    });
  }

  return (
    <div
      className={`${styles.root} ${className}`}
      ref={rootRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={resolvedOrientation}
      data-orientation={resolvedOrientation}
      data-keyboard-navigation={keyboardNavigation ? "true" : "false"}
    >
      {visibleOptions.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) tabRefs.current.set(option.value, node);
              else tabRefs.current.delete(option.value);
            }}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            className={styles.trigger}
            data-active={active ? "true" : "false"}
            onClick={() => {
              setKeyboardNavigation(false);
              onValueChange(option.value);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {active ? <span className={styles.indicator} aria-hidden="true" /> : null}
            <span className={styles.label}>
              {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
              <span>{option.label}</span>
              {option.badge !== undefined ? <span className={styles.badge}>{option.badge}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
