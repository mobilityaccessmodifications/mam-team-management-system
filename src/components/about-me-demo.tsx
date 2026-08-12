"use client";

import {
  BadgeCheck,
  Cake,
  HeartHandshake,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";

import styles from "@/components/about-me-demo.module.css";

export type AboutMeDemoProps = {
  roleLabel: string;
  team: string;
  manager: string;
  /** Fixed fictional date used only to demonstrate tenure and an anniversary state. */
  startedDate?: string;
  syntheticToday?: string;
  company?: "mam" | "equipsy";
};

type HelpContact = {
  title: string;
  name: string;
  email: string;
  icon: typeof UsersRound;
};

type SpecialDay = {
  title: string;
  description: string;
  icon: typeof Cake;
};

const DEMO_TODAY = "2026-08-11";

function dateParts(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function toUtcTimestamp(value: string) {
  const { year, month, day } = dateParts(value);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(start: string, end: string) {
  return Math.max(0, Math.floor((toUtcTimestamp(end) - toUtcTimestamp(start)) / 86_400_000));
}

function dateWithYear(value: string, year: number) {
  const { month, day } = dateParts(value);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function sameMonthDay(first: string, second: string) {
  const firstParts = dateParts(first);
  const secondParts = dateParts(second);
  return firstParts.month === secondParts.month && firstParts.day === secondParts.day;
}

function yearsAtCompany(startedDate: string, today: string) {
  const start = dateParts(startedDate);
  const current = dateParts(today);
  const anniversaryThisYear = dateWithYear(startedDate, current.year);
  return Math.max(0, current.year - start.year - (toUtcTimestamp(today) < toUtcTimestamp(anniversaryThisYear) ? 1 : 0));
}

function makeSyntheticEmail(value: string) {
  const localPart = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `${localPart || "team"}@example.test`;
}

function anniversaryFor(today: string, startedDate: string, years: number, companyName: string): SpecialDay | null {
  if (!sameMonthDay(today, startedDate)) return null;

  return {
    title: years === 1 ? `One year at ${companyName}` : `${years} years at ${companyName}`,
    description: "Thank you for the work and care you bring to the team.",
    icon: years > 0 ? BadgeCheck : Cake,
  };
}

/** A compact, browser-local profile panel rendered within the People workspace. */
export function AboutMeDemo({
  roleLabel,
  team,
  manager,
  startedDate: startedDateProp,
  syntheticToday = DEMO_TODAY,
  company = "mam",
}: AboutMeDemoProps) {
  const companyName = company === "equipsy" ? "Equipsy" : "MAM";
  const startedDate = startedDateProp ?? "2024-08-11";
  const daysAtCompany = daysBetween(startedDate, syntheticToday);
  const years = yearsAtCompany(startedDate, syntheticToday);
  const specialDay = anniversaryFor(syntheticToday, startedDate, years, companyName);
  const SpecialDayIcon = specialDay?.icon;
  const contacts: HelpContact[] = [
    {
      title: "Your manager",
      name: manager,
      email: makeSyntheticEmail(manager),
      icon: UsersRound,
    },
    {
      title: "People & Culture",
      name: "People team",
      email: "people@example.test",
      icon: HeartHandshake,
    },
    {
      title: "IT support",
      name: "IT service desk",
      email: "it-support@example.test",
      icon: ShieldCheck,
    },
  ];

  return (
    <section className={styles.workspace} aria-label="My profile">
      {specialDay && SpecialDayIcon ? (
        <section className={styles.specialDay} aria-label={specialDay.title}>
          <span className={styles.specialDayIcon} aria-hidden="true">
            <SpecialDayIcon size={18} strokeWidth={2.25} />
          </span>
          <div>
            <strong>{specialDay.title}</strong>
            <p>{specialDay.description}</p>
          </div>
          <Sparkles className={styles.specialDaySparkles} aria-hidden="true" size={18} />
        </section>
      ) : null}

      <section className={styles.profileCard} aria-label={`${companyName} profile summary`}>
        <div className={styles.profileSummary}>
          <span>{roleLabel} <i aria-hidden="true">·</i> {team}</span>
          <strong>{daysAtCompany.toLocaleString()} <small>days at {companyName}</small></strong>
        </div>
      </section>

      <section className={styles.contactsCard} aria-labelledby="contacts-heading">
        <header>
          <h2 id="contacts-heading">Who to contact</h2>
        </header>
        <div className={styles.contactList}>
          {contacts.map((contact) => {
            const ContactIcon = contact.icon;
            return (
              <a key={contact.title} href={`mailto:${contact.email}`} aria-label={`Email ${contact.name} at ${contact.email}`}>
                <span className={styles.contactIcon} aria-hidden="true"><ContactIcon size={16} /></span>
                <span>
                  <strong>{contact.title}</strong>
                  <small>{contact.name}</small>
                </span>
                <span className={styles.contactAction}>Email</span>
              </a>
            );
          })}
        </div>
      </section>
    </section>
  );
}
