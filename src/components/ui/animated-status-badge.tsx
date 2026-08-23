"use client";

// Adapted for Safer from beui.dev/components/motion/animated-badge.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Check, Circle, Clock3, LoaderCircle, X } from "lucide-react";
import { EASE_OUT } from "@/lib/ease";
import styles from "./animated-status-badge.module.css";

type Tone = "neutral" | "info" | "loading" | "success" | "warning" | "danger";

const icons = {
  neutral: Circle,
  info: Clock3,
  loading: LoaderCircle,
  success: Check,
  warning: AlertTriangle,
  danger: X,
} satisfies Record<Tone, typeof Circle>;

export function AnimatedStatusBadge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const Icon = icons[tone];

  return (
    <span className={`${styles.badge} ${className}`} data-tone={tone}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={tone}
          className={styles.icon}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.65, rotate: -12 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.65, rotate: 12 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          aria-hidden="true"
        >
          <Icon className={tone === "loading" && !reduceMotion ? styles.spinning : undefined} size={12} />
        </motion.span>
      </AnimatePresence>
      <span>{children}</span>
    </span>
  );
}
