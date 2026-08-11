"use client";

import {
  BadgeCheck,
  BriefcaseBusiness,
  Cake,
  HeartHandshake,
  Mail,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";

import styles from "@/components/about-me-demo.module.css";

export type AboutMeDemoProps = {
  name: string;
  initials: string;
  roleLabel: string;
  team: string;
  manager: string;
  /** Fixed fictional date used only to demonstrate tenure and an anniversary state. */
  startedDate?: string;
  syntheticToday?: string;
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

function yearsAtMam(startedDate: string, today: string) {
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

function anniversaryFor(today: string, startedDate: string, years: number): SpecialDay | null {
  if (!sameMonthDay(today, startedDate)) return null;

  return {
    title: years === 1 ? "One year at MAM" : `${years} years at MAM`,
    description: "Thank you for the work and care you bring to the team.",
    icon: years > 0 ? BadgeCheck : Cake,
  };
}

/** A compact, browser-local profile panel rendered within the People workspace. */
export function AboutMeDemo({
  name,
  initials,
  roleLabel,
  team,
  manager,
  startedDate: startedDateProp,
  syntheticToday = DEMO_TODAY,
}: AboutMeDemoProps) {
  const startedDate = startedDateProp ?? "2024-08-11";
  const daysAtMam = daysBetween(startedDate, syntheticToday);
  const years = yearsAtMam(startedDate, syntheticToday);
  const specialDay = anniversaryFor(syntheticToday, startedDate, years);
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
      name: "MAM People team",
      email: "people@example.test",
      icon: HeartHandshake,
    },
    {
      title: "IT support",
      name: "MAM IT service desk",
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

      <section className={styles.profileCard} aria-labelledby="profile-summary-heading">
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">{initials}</span>
          <div>
            <h2 id="profile-summary-heading">{name}</h2>
            <p>{roleLabel} <span aria-hidden="true">·</span> {team}</p>
          </div>
        </div>
        <dl className={styles.tenure}>
          <div>
            <dt>At MAM</dt>
            <dd>{daysAtMam.toLocaleString()} <small>days</small></dd>
          </div>
        </dl>
      </section>

      <section className={styles.contactsCard} aria-labelledby="contacts-heading">
        <header>
          <div>
            <span>Need help?</span>
            <h2 id="contacts-heading">Contact the right team</h2>
          </div>
          <Mail aria-hidden="true" size={18} />
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
                <span className={styles.contactEmail}>{contact.email}</span>
                <Mail aria-hidden="true" size={14} />
              </a>
            );
          })}
        </div>
        <p className={styles.contactFootnote}><BriefcaseBusiness aria-hidden="true" size={14} /> Contact details are fictional in this synthetic demo.</p>
      </section>
    </section>
  );
}
