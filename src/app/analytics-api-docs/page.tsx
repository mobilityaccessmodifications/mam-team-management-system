import Link from "next/link";

import styles from "./page.module.css";

const datasets = [
  ["overview", "Headcount, asset and subscription totals, plus date-filtered leave/check-in totals."],
  ["employees", "Current directory facts and archived/active status."],
  ["leave_requests", "Durable leave workflow records."],
  ["leave_events", "Leave request and decision history."],
  ["check_ins", "Check-in schedule and status records."],
  ["check_in_events", "Check-in delivery and completion history."],
  ["asset_custody", "Device assignment and return periods."],
  ["subscriptions", "Subscription register facts."],
  ["subscription_events", "Subscription review and change history."],
] as const;

export default function AnalyticsApiDocsPage() {
  return <main className={styles.page}>
    <Link className={styles.back} href="/?view=people">← People Hub</Link>
    <header className={styles.header}>
      <span>System Admin · API reference</span>
      <h1>Analytics API</h1>
      <p>Read-only server-to-server reporting for approved dashboard connectors and analytics backends. Do not call this API from browser code.</p>
    </header>

    <section className={styles.card}>
      <h2>Authentication</h2>
      <p>Send the dedicated Analytics API key as a bearer token. System Admin generates it from People → Analytics API. It is shown once; only its hash is retained. Rotation invalidates the previous key immediately.</p>
      <pre><code>Authorization: Bearer &lt;ANALYTICS_API_KEY&gt;</code></pre>
      <p>Never use or share Supabase keys, a Supabase Management API token, a portal login, or a subscription credential. The endpoint does not enable browser CORS.</p>
    </section>

    <section className={styles.card}>
      <h2>Endpoint</h2>
      <pre><code>GET /api/analytics/v1</code></pre>
      <h3>Query parameters</h3>
      <div className={styles.tableWrap}><table><thead><tr><th>Parameter</th><th>Default</th><th>Rules</th></tr></thead><tbody>
        <tr><td><code>dataset</code></td><td><code>overview</code></td><td>One of the datasets below.</td></tr>
        <tr><td><code>from</code></td><td>All available history</td><td>Inclusive <code>YYYY-MM-DD</code>.</td></tr>
        <tr><td><code>to</code></td><td>All available history</td><td>Inclusive <code>YYYY-MM-DD</code>.</td></tr>
        <tr><td><code>limit</code></td><td><code>500</code></td><td>Record datasets: 1–1000 rows.</td></tr>
        <tr><td><code>offset</code></td><td><code>0</code></td><td>Pagination offset, up to 1,000,000.</td></tr>
      </tbody></table></div>
    </section>

    <section className={styles.card}>
      <h2>Datasets</h2>
      <ul className={styles.datasets}>{datasets.map(([name, description]) => <li key={name}><code>{name}</code><span>{description}</span></li>)}</ul>
      <p>Results include eligible historical records stored by the system; they do not invent a timeline for fields predating their durable register.</p>
    </section>

    <section className={styles.card}>
      <h2>Example</h2>
      <pre><code>{`curl --fail --silent \\
  -H "Authorization: Bearer $MAM_ANALYTICS_API_KEY" \\
  "https://mam-team-management-system-ten.vercel.app/api/analytics/v1?dataset=check_ins&from=2026-01-01&to=2026-12-31&limit=1000"`}</code></pre>
      <p>Responses include <code>data</code> and pagination metadata. Store the key in the connector’s encrypted secret settings; never place it in browser JavaScript, a spreadsheet, chat, email, or source code.</p>
    </section>

    <section className={styles.card}>
      <h2>Data boundaries</h2>
      <p>The API excludes personal/work email, phone, date of birth, address, leave type/reason, manager notes, leave evidence, authentication data, passwords, recovery codes, asset passcodes, and subscription credentials.</p>
      <p>Employee and object UUIDs are stable operational identifiers for joins between approved datasets. They are not database credentials and cannot be used to query Supabase directly.</p>
    </section>
  </main>;
}
