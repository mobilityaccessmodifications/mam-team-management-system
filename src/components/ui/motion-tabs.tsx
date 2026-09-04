"use client";

// Adapted for Safer from beui.dev/components/motion/tabs.

import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { SPRING_LAYOUT } from "@/lib/ease";
import styles from "./motion-tabs.module.css";

export type MotionTabOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
  hidden?: boolean;
};

export function MotionTabs<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className = "",
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: MotionTabOption<T>[];
  ariaLabel: string;
  className?: string;
}) {
  const layoutId = useId();
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const active = root?.querySelector<HTMLElement>('[data-active="true"]');
    if (!root || !active) return;

    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < root.scrollLeft || right > root.scrollLeft + root.clientWidth) {
      root.scrollTo({
        left: Math.max(0, left - (root.clientWidth - active.offsetWidth) / 2),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  }, [reduceMotion, value]);

  return (
    <MotionConfig transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}>
      <div className={`${styles.root} ${className}`} ref={rootRef} role="group" aria-label={ariaLabel}>
        {options.filter((option) => !option.hidden).map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              className={styles.trigger}
              data-active={active ? "true" : "false"}
              onClick={() => onValueChange(option.value)}
            >
              {active ? (
                <motion.span
                  layoutId={layoutId}
                  layout="position"
                  className={styles.indicator}
                  aria-hidden="true"
                />
              ) : null}
              <span className={styles.label}>
                {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
                <span>{option.label}</span>
                {option.badge !== undefined ? <span className={styles.badge}>{option.badge}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </MotionConfig>
  );
}
