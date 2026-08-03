import {
  ArrowUpRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  LayoutDashboard,
  Plus,
  Settings2,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";

import { BrandMark } from "@/components/brand-mark";

const navItems = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Leave requests", icon: CalendarDays },
  { label: "Team directory", icon: UsersRound },
  { label: "Approvals", icon: UserRoundCheck, badge: "3" },
  { label: "Settings", icon: Settings2 },
];

const teamAvailability = [
  {
    name: "Taylor M.",
    role: "Team lead",
    initials: "SM",
    days: ["work", "work", "leave", "leave", "work"],
  },
  {
    name: "Morgan R.",
    role: "Field team",
    initials: "BR",
    days: ["work", "site", "site", "work", "work"],
  },
  {
    name: "Casey T.",
    role: "Field team",
    initials: "KT",
    days: ["leave", "leave", "work", "work", "work"],
  },
  {
    name: "Jamie L.",
    role: "Accounts",
    initials: "PL",
    days: ["work", "work", "work", "work", "remote"],
  },
];

const requests = [
  {
    person: "Jordan P.",
    dates: "10–12 Aug",
    type: "Annual leave",
    status: "Needs review",
  },
  {
    person: "Mia C.",
    dates: "18 Aug",
    type: "Personal leave",
    status: "Needs review",
  },
  {
    person: "Alex N.",
    dates: "24–28 Aug",
    type: "Annual leave",
    status: "Coverage check",
  },
];

const dayLabels = ["MON 03", "TUE 04", "WED 05", "THU 06", "FRI 07"];

export default function Home() {
  return (
    <div className="portal-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="sidebar" aria-label="Primary navigation">
        <BrandMark />
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a
                className={`nav-item${item.active ? " nav-item-active" : ""}`}
                href={item.active ? "#main-content" : "#foundation-note"}
                key={item.label}
              >
                <Icon aria-hidden="true" size={19} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </a>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Foundation preview</strong>
            <span>Supabase not connected</span>
          </div>
        </div>
      </aside>

      <div className="portal-main">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandMark compact />
          </div>
          <div className="topbar-context">
            <span>MAM Operations</span>
            <strong>Team Management</strong>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="Notifications">
              <Bell size={19} aria-hidden="true" />
              <span className="notification-pip" aria-hidden="true" />
            </button>
            <div className="user-chip" aria-label="Signed in as Nixon">
              <span className="avatar avatar-dark">NC</span>
              <span className="user-copy">
                <strong>Nixon</strong>
                <span>System owner</span>
              </span>
            </div>
          </div>
        </header>

        <main id="main-content" className="dashboard">
          <section className="dashboard-intro" aria-labelledby="dashboard-title">
            <div>
              <p className="eyebrow">Monday, 3 August</p>
              <h1 id="dashboard-title">Know who is available before the day starts.</h1>
              <p className="intro-copy">
                One view for leave, coverage and manager decisions across MAM teams.
              </p>
            </div>
            <a className="primary-action" href="#foundation-note" aria-label="Create a leave request">
              <Plus aria-hidden="true" size={19} />
              Create request
            </a>
          </section>

          <section className="summary-grid" aria-label="Team summary">
            <article className="summary-card summary-card-accent">
              <div className="summary-icon"><ClipboardList size={21} aria-hidden="true" /></div>
              <div>
                <span>Waiting for review</span>
                <strong>3</strong>
                <small>Manager action needed</small>
              </div>
            </article>
            <article className="summary-card">
              <div className="summary-icon"><UsersRound size={21} aria-hidden="true" /></div>
              <div>
                <span>Available today</span>
                <strong>28</strong>
                <small>Across four teams</small>
              </div>
            </article>
            <article className="summary-card">
              <div className="summary-icon"><CalendarDays size={21} aria-hidden="true" /></div>
              <div>
                <span>Away this week</span>
                <strong>4</strong>
                <small>Coverage confirmed for 3</small>
              </div>
            </article>
            <article className="summary-card">
              <div className="summary-icon"><CheckCircle2 size={21} aria-hidden="true" /></div>
              <div>
                <span>Decided this month</span>
                <strong>16</strong>
                <small>2-day average turnaround</small>
              </div>
            </article>
          </section>

          <section className="work-grid">
            <article className="panel roster-panel" aria-labelledby="availability-title">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Coverage board</p>
                  <h2 id="availability-title">This week</h2>
                </div>
                <a href="#foundation-note">View full calendar <ArrowUpRight size={15} aria-hidden="true" /></a>
              </div>

              <div className="roster" role="table" aria-label="Weekly team availability preview">
                <div className="roster-head" role="row">
                  <span role="columnheader">Team member</span>
                  {dayLabels.map((day, index) => (
                    <span className={index === 0 ? "today" : ""} role="columnheader" key={day}>{day}</span>
                  ))}
                </div>
                {teamAvailability.map((person) => (
                  <div className="roster-row" role="row" key={person.name}>
                    <div className="person-cell" role="rowheader">
                      <span className="avatar">{person.initials}</span>
                      <span><strong>{person.name}</strong><small>{person.role}</small></span>
                    </div>
                    {person.days.map((day, index) => (
                      <span
                        className={`availability availability-${day}${index === 0 ? " today" : ""}`}
                        role="cell"
                        key={`${person.name}-${day}-${index}`}
                      >
                        {day === "leave" ? "Leave" : day === "remote" ? "Remote" : day === "site" ? "On site" : "Available"}
                      </span>
                    ))}
                  </div>
                ))}
              </div>

              <div className="legend" aria-label="Availability legend">
                <span><i className="legend-work" /> Available</span>
                <span><i className="legend-site" /> On site</span>
                <span><i className="legend-leave" /> Leave</span>
                <span><i className="legend-remote" /> Remote</span>
              </div>
            </article>

            <article className="panel requests-panel" id="requests" aria-labelledby="requests-title">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Manager queue</p>
                  <h2 id="requests-title">Needs a decision</h2>
                </div>
                <span className="count-pill">3 open</span>
              </div>

              <div className="request-list">
                {requests.map((request) => (
                  <a className="request-row" href="#foundation-note" key={`${request.person}-${request.dates}`}>
                    <div className="request-date">
                      <CalendarDays size={16} aria-hidden="true" />
                      <span>{request.dates}</span>
                    </div>
                    <div className="request-copy">
                      <strong>{request.person}</strong>
                      <span>{request.type}</span>
                      <small>{request.status}</small>
                    </div>
                    <ChevronRight size={18} aria-hidden="true" />
                  </a>
                ))}
              </div>
              <a className="secondary-action" href="#foundation-note">Review all requests</a>
            </article>
          </section>

          <section className="foundation-note" id="foundation-note" aria-labelledby="foundation-title">
            <div className="foundation-icon"><Clock3 size={20} aria-hidden="true" /></div>
            <div>
              <strong id="foundation-title">Foundation build</strong>
              <p>
                This screen uses safe sample data. Authentication, approval rules and live staff data
                will be connected only after MAM confirms the workflow and Supabase environment.
              </p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
