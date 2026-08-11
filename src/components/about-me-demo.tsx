"use client";

import {
  BadgeCheck,
  BriefcaseBusiness,
  CalendarDays,
  Cake,
  Clock3,
  HeartHandshake,
  Mail,
  MapPin,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";

import styles from "@/components/about-me-demo.module.css";

export type AboutMeAccessRole = "hr" | "manager" | "employee";

export type AboutMeDemoProps = {
  name: string;
  initials: string;
  accessRole: AboutMeAccessRole;
  roleLabel: string;
  team: string;
  manager: string;
  /** Optional synthetic values make special-day states easy to review. */
  startedDate?: string;
  birthday?: string;
  recognitionDay?: string;
  syntheticToday?: string;
};

type HelpContact = {
  title: string;
  name: string;
  email: string;
  description: string;
  icon: typeof UsersRound;
};

type SpecialDay = {
  kind: "birthday" | "anniversary" | "recognition";
  title: string;
  description: string;
  icon: typeof Cake;
};

const DEMO_TODAY = "2026-08-11";
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function dateParts(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function formatDate(value: string) {
  const { year, month, day } = dateParts(value);
  return `${day} ${MONTHS[month - 1]} ${year}`;
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

function defaultRecognitionDay(team: string, year: number) {
  const normalizedTeam = team.toLowerCase();
  if (normalizedTeam.includes("major")) return `${year}-08-11`;
  if (normalizedTeam.includes("minor")) return `${year}-09-22`;
  if (normalizedTeam.includes("people")) return `${year}-10-12`;
  if (normalizedTeam.includes("account")) return `${year}-11-06`;
  return `${year}-12-02`;
}

function nextAnniversary(startedDate: string, today: string) {
  const todayYear = dateParts(today).year;
  const thisYear = dateWithYear(startedDate, todayYear);
  return toUtcTimestamp(thisYear) < toUtcTimestamp(today) ? dateWithYear(startedDate, todayYear + 1) : thisYear;
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

function roleDescriptor(accessRole: AboutMeAccessRole) {
  if (accessRole === "hr") return "People operations access";
  if (accessRole === "manager") return "Team leader access";
  return "Employee self-service";
}

function specialDayFor(
  today: string,
  startedDate: string,
  birthday: string | undefined,
  recognitionDay: string,
  years: number,
): SpecialDay | null {
  if (birthday && sameMonthDay(today, birthday)) {
    return {
      kind: "birthday",
      title: "Happy birthday",
      description: "A small moment to celebrate you. Your work profile stays private.",
      icon: Cake,
    };
  }

  if (sameMonthDay(today, startedDate)) {
    return {
      kind: "anniversary",
      title: years === 1 ? "One year at MAM" : `${years} years at MAM`,
      description: "Thank you for the work and care you bring to the team.",
      icon: BadgeCheck,
    };
  }

  if (sameMonthDay(today, recognitionDay)) {
    return {
      kind: "recognition",
      title: "Team recognition day",
      description: "Today MAM is recognising the contribution of your team.",
      icon: Sparkles,
    };
  }

  return null;
}

export function AboutMeDemo({
  name,
  initials,
  accessRole,
  roleLabel,
  team,
  manager,
  startedDate: startedDateProp,
  birthday: birthdayProp,
  recognitionDay: recognitionDayProp,
  syntheticToday = DEMO_TODAY,
}: AboutMeDemoProps) {
  const startedDate = startedDateProp ?? "2024-08-11";
  const birthday = birthdayProp;
  const todayYear = dateParts(syntheticToday).year;
  const recognitionDay = recognitionDayProp ?? defaultRecognitionDay(team, todayYear);
  const daysAtMam = daysBetween(startedDate, syntheticToday);
  const years = yearsAtMam(startedDate, syntheticToday);
  const anniversary = nextAnniversary(startedDate, syntheticToday);
  const specialDay = specialDayFor(syntheticToday, startedDate, birthday, recognitionDay, years);
  const SpecialDayIcon = specialDay?.icon;

  const contacts: HelpContact[] = [
    {
      title: "Your manager",
      name: manager,
      email: makeSyntheticEmail(manager),
      description: "Work priorities, leave and day-to-day support.",
      icon: UsersRound,
    },
    {
      title: "People & Culture",
      name: "MAM People team",
      email: "people@example.test",
      description: "Employment details, wellbeing and policy help.",
      icon: HeartHandshake,
    },
    {
      title: "IT support",
      name: "MAM IT service desk",
      email: "it-support@example.test",
      description: "Devices, access and software support.",
      icon: ShieldCheck,
    },
    {
      title: "Accounts",
      name: "MAM Accounts team",
      email: "accounts@example.test",
      description: "Payroll, expenses and account queries.",
      icon: BriefcaseBusiness,
    },
  ];

  return (
    <section className={styles.workspace} aria-labelledby="about-me-heading">
      <header className={styles.pageHeader}>
        <div>
          <span>My MAM profile</span>
          <h1 id="about-me-heading">About me</h1>
          <p>One place to find your work details, key contacts and MAM milestones.</p>
        </div>
        <div className={styles.localBadge}>
          <ShieldCheck aria-hidden="true" size={15} />
          <span>Synthetic demo profile</span>
        </div>
      </header>

      <div className={styles.syntheticNote} role="note">
        <ShieldCheck aria-hidden="true" size={16} />
        <span>
          This page uses browser-local, fictional profile details. It does not read or update employee records.
        </span>
      </div>

      {specialDay && SpecialDayIcon ? (
        <section className={styles.specialDay} aria-label={specialDay.title}>
          <span className={styles.specialDayIcon} aria-hidden="true">
            <SpecialDayIcon size={19} strokeWidth={2.25} />
          </span>
          <div>
            <strong>{specialDay.title}</strong>
            <p>{specialDay.description}</p>
          </div>
          <Sparkles className={styles.specialDaySparkles} aria-hidden="true" size={21} />
        </section>
      ) : null}

      <section className={styles.profileCard} aria-labelledby="profile-summary-heading">
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">{initials}</span>
          <div>
            <span className={styles.eyebrow}>{roleDescriptor(accessRole)}</span>
            <h2 id="profile-summary-heading">{name}</h2>
            <p>{roleLabel} <span aria-hidden="true">·</span> {team}</p>
          </div>
        </div>
        <dl className={styles.tenure}>
          <div>
            <dt>At MAM</dt>
            <dd>{daysAtMam.toLocaleString()} <small>days</small></dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{formatDate(startedDate)}</dd>
          </div>
          <div>
            <dt>Next anniversary</dt>
            <dd>{formatDate(anniversary)}</dd>
          </div>
        </dl>
      </section>

      <div className={styles.contentGrid}>
        <section className={styles.detailsCard} aria-labelledby="work-details-heading">
          <header>
            <div>
              <span>Work details</span>
              <h2 id="work-details-heading">Your place in the team</h2>
            </div>
            <BriefcaseBusiness aria-hidden="true" size={19} />
          </header>
          <dl className={styles.detailsList}>
            <div>
              <dt><BriefcaseBusiness aria-hidden="true" size={15} /> Role</dt>
              <dd>{roleLabel}</dd>
            </div>
            <div>
              <dt><UsersRound aria-hidden="true" size={15} /> Team</dt>
              <dd>{team}</dd>
            </div>
            <div>
              <dt><HeartHandshake aria-hidden="true" size={15} /> Reports to</dt>
              <dd>{manager}</dd>
            </div>
            <div>
              <dt><Clock3 aria-hidden="true" size={15} /> Support hours</dt>
              <dd>Monday–Friday, 6:00 am–6:00 pm</dd>
            </div>
            <div>
              <dt><MapPin aria-hidden="true" size={15} /> Work base</dt>
              <dd>Victoria operations <small>Synthetic example</small></dd>
            </div>
            <div>
              <dt><CalendarDays aria-hidden="true" size={15} /> Team check-in</dt>
              <dd>Weekly with {manager}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.contactsCard} aria-labelledby="contacts-heading">
          <header>
            <div>
              <span>Who can help?</span>
              <h2 id="contacts-heading">Quick contacts</h2>
            </div>
            <Mail aria-hidden="true" size={19} />
          </header>
          <div className={styles.contactList}>
            {contacts.map((contact) => {
              const ContactIcon = contact.icon;
              return (
                <article key={contact.title}>
                  <span className={styles.contactIcon} aria-hidden="true"><ContactIcon size={16} /></span>
                  <div>
                    <strong>{contact.title}</strong>
                    <span>{contact.name}</span>
                    <p>{contact.description}</p>
                  </div>
                  <a href={`mailto:${contact.email}`} aria-label={`Email ${contact.name} at ${contact.email}`}>
                    <Mail aria-hidden="true" size={14} />
                    <span>{contact.email}</span>
                  </a>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <aside className={styles.privacyNote} aria-label="Profile data privacy note">
        <ShieldCheck aria-hidden="true" size={18} />
        <div>
          <strong>Keep profile details private</strong>
          <p>
            In a live rollout, only you, your authorised manager and People &amp; Culture should see the fields needed for their work. Do not add medical, payroll or personal information to this demo page.
          </p>
        </div>
      </aside>
    </section>
  );
}
