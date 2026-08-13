"use client";

import { Building2, UserRound } from "lucide-react";

import styles from "@/components/about-me-demo.module.css";

export type AboutMeDemoProps = {
  roleLabel: string;
  manager: string;
  company?: "mam" | "equipsy";
};

/** The signed-in person's essential organisation details. */
export function AboutMeDemo({
  roleLabel,
  manager,
  company = "mam",
}: AboutMeDemoProps) {
  const companyName = company === "equipsy" ? "Equipsy" : "MAM";

  return (
    <section className={styles.workspace} aria-label="My profile">
      <section className={styles.profileCard} aria-label={`${companyName} profile summary`}>
        <div className={styles.profileSummary}>
          <span><Building2 aria-hidden="true" size={16} /> Company</span>
          <strong>{companyName}</strong>
        </div>
        <div className={styles.profileSummary}>
          <span>Position</span>
          <strong>{roleLabel}</strong>
        </div>
        {manager ? (
          <div className={styles.profileSummary}>
            <span><UserRound aria-hidden="true" size={16} /> Manager</span>
            <strong>{manager}</strong>
          </div>
        ) : null}
      </section>
    </section>
  );
}
