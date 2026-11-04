"use client";

import { ExternalLink, LockKeyhole } from "lucide-react";

const apps = [
  {
    name: "AroFlo",
    url: "https://aroflo.com/",
    description: "Manage jobs, quotes, scheduling and field work across MAM operations in our core job management system.",
    initials: "AF",
    accent: "#176b7b",
  },
  {
    name: "MAM Picked",
    url: "https://mam-picked.vercel.app/",
    description: "Organise warehouse picking, stock requests and returns so materials are ready for our trade teams.",
    initials: "MP",
    accent: "#dd6b20",
  },
  {
    name: "MAM Drafty Booking",
    url: "https://mam-drafty-booking-git-feature-public-4cbd5b-ai-7033s-projects.vercel.app/",
    description: "Coordinate draftsperson appointments and bookings for Major Modifications jobs.",
    initials: "DB",
    accent: "#2563eb",
  },
  {
    name: "MAM Learning",
    url: "https://mamlearning.ispring.com/courses",
    description: "Access training modules and learning resources to build skills and follow MAM procedures.",
    initials: "ML",
    accent: "#7c3aed",
  },
  {
    name: "Trello",
    url: "https://trello.com/",
    description: "Track improvement ideas, projects and team tasks in shared workflow boards.",
    initials: "TR",
    accent: "#0284c7",
  },
  {
    name: "Power BI Reports",
    url: "https://app.powerbi.com/",
    description: "View reporting dashboards and performance measures to support day-to-day decisions.",
    initials: "BI",
    accent: "#b7791f",
  },
] as const;

const equipsyApps = [
  {
    name: "Donut",
    url: "https://equipsy-donut.vercel.app/",
    description: "Track Equipsy orders waiting to be picked so the warehouse knows what needs preparing.",
    initials: "DN",
    accent: "#1f766e",
  },
  {
    name: "Tiramisu",
    url: "https://deft-tiramisu-3790ab.netlify.app/",
    description: "Track Equipsy orders and their progress from placement through fulfilment.",
    initials: "TI",
    accent: "#7b5c9e",
  },
  {
    name: "5S Audit",
    url: "https://5s-audit-wine.vercel.app/",
    description: "Complete workplace 5S audits to support organisation, cleanliness and continuous improvement.",
    initials: "5S",
    accent: "#b65b25",
  },
] as const;

export function AppsLanding({ company, isManagement }: { company: "mam" | "equipsy"; isManagement: boolean }) {
  const showMamApps = isManagement || company === "mam";
  const showEquipsyApps = isManagement || company === "equipsy";
  return (
    <section aria-labelledby="apps-landing-title" style={{ padding: "12px 0 28px" }}>
      <div style={{ marginBottom: 22 }}>
        <p style={{ color: "#b65b25", fontSize: 12, letterSpacing: "0.08em", fontWeight: 750, textTransform: "uppercase", marginBottom: 7 }}>Your workplace tools</p>
        <h1 id="apps-landing-title" style={{ fontSize: "clamp(25px, 3vw, 34px)", fontWeight: 750, letterSpacing: "-0.035em", margin: 0 }}>MAM &amp; Equipsy Apps</h1>
        <p style={{ marginTop: 10, color: "var(--muted, #64748b)", maxWidth: 650, lineHeight: 1.55 }}>Quick access to the systems we use across our teams.</p>
      </div>
      {showMamApps ? <>
      <h2 style={{ margin: "0 0 16px", fontSize: 22, fontWeight: 750 }}>MAM &amp; Shared Apps</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 245px), 1fr))", gap: 16 }}>
        {apps.map((app) => (
          <a key={app.name} href={app.url} target="_blank" rel="noopener noreferrer"
            style={{ display: "flex", flexDirection: "column", minHeight: 194, textDecoration: "none", color: "inherit", border: "1px solid var(--line, #dce1e7)", borderRadius: 16, padding: 20, background: "var(--surface, #fff)", boxShadow: "0 2px 12px rgba(19,35,56,.045)", transition: "border-color 160ms, transform 160ms" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 17 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: app.accent, color: "#fff", fontWeight: 800, fontSize: 13 }}>{app.initials}</span>
              <ExternalLink size={17} aria-hidden="true" style={{ opacity: 0.6 }} />
            </div>
            <strong style={{ fontSize: 17, marginBottom: 7 }}>{app.name}</strong>
            <span style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--muted, #64748b)" }}>{app.description}</span>
          </a>
        ))}
      </div>
      </> : null}
      {showEquipsyApps ? <>
      <div style={{ margin: "36px 0 18px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 750, margin: "0 0 8px" }}>Equipsy Apps</h2>
        <p style={{ margin: 0, color: "var(--muted, #64748b)", lineHeight: 1.55 }}>Quick links to Equipsy-specific tools.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 245px), 1fr))", gap: 16 }}>
        {equipsyApps.map((app) => (
          <a key={app.name} href={app.url} target="_blank" rel="noopener noreferrer"
            style={{ display: "flex", flexDirection: "column", minHeight: 194, textDecoration: "none", color: "inherit", border: "1px solid var(--line, #dce1e7)", borderRadius: 16, padding: 20, background: "var(--surface, #fff)", boxShadow: "0 2px 12px rgba(19,35,56,.045)", transition: "border-color 160ms, transform 160ms" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 17 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: app.accent, color: "#fff", fontWeight: 800, fontSize: 13 }}>{app.initials}</span>
              <ExternalLink size={17} aria-hidden="true" style={{ opacity: 0.6 }} />
            </div>
            <strong style={{ fontSize: 17, marginBottom: 7 }}>{app.name}</strong>
            <span style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--muted, #64748b)" }}>{app.description}</span>
          </a>
        ))}
      </div>
      </> : null}
      <p style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20, fontSize: 13, color: "var(--muted, #64748b)" }}>
        <LockKeyhole size={15} aria-hidden="true" /> Access to each system depends on your existing account and permissions. People Hub does not automatically sign you in.
      </p>
    </section>
  );
}
