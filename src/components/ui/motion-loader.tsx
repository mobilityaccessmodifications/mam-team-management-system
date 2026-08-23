"use client";

// Adapted for Safer from beui.dev/components/motion/loader.

import { motion, useReducedMotion } from "motion/react";
import styles from "./motion-loader.module.css";

export function MotionLoader({ label = "Loading" }: { label?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <span className={styles.loader} role="status" aria-label={label}>
      {[0, 1, 2].map((index) => (
        <motion.i
          key={index}
          animate={reduceMotion ? { opacity: 0.65 } : { opacity: [0.35, 1, 0.35], y: [0, -3, 0] }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.9, repeat: Infinity, delay: index * 0.12 }}
        />
      ))}
      <span>{label}</span>
    </span>
  );
}
