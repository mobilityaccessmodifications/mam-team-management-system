"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type CompanyDirectoryRow = {
  employee_name: string;
  company: string;
  department: string;
  job_title: string;
  work_location: string;
  employment_type: string;
  work_email: string;
  work_phone: string;
};

type CompanyAssetRow = {
  asset_code: string;
  asset_type: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  asset_status: string;
  assigned_person_name: string;
  assigned_on: string | null;
};

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 };
const thStyle = { padding: "12px", borderBottom: "1px solid var(--line, #dce1e7)", textAlign: "left" as const, fontWeight: 700 };
const tdStyle = { padding: "12px", borderBottom: "1px solid var(--line, #e5e7eb)", textAlign: "left" as const, verticalAlign: "top" as const };

function SafeTable({ headings, rows }: { headings: string[]; rows: (string | null)[][] }) {
  return <div style={{ overflowX: "auto", width: "100%", border: "1px solid var(--line, #dce1e7)", borderRadius: 12 }}>
    <table style={tableStyle}>
      <thead><tr>{headings.map((heading) => <th key={heading} scope="col" style={thStyle}>{heading}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell} style={tdStyle}>{value || "—"}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function useCompanyReadOnlyRows<T>(rpcName: "list_people_company_directory_readonly" | "list_people_company_assets_readonly", previewPersonId?: string) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const supabase = createClient();
    void (async () => {
      const previewRpcName = rpcName === "list_people_company_directory_readonly"
        ? "list_people_company_directory_readonly_for_preview"
        : "list_people_company_assets_readonly_for_preview";
      const { data, error: requestError } = previewPersonId
        ? await supabase.rpc(previewRpcName, { p_person_id: previewPersonId })
        : await supabase.rpc(rpcName);
      if (!mounted) return;
      if (requestError || !Array.isArray(data)) {
        setRows([]);
        setError("This register could not be loaded. Refresh the page and try again.");
      } else {
        setRows(data as T[]);
        setError("");
      }
      setLoading(false);
    })().catch(() => {
      if (mounted) { setRows([]); setError("This register could not be loaded."); setLoading(false); }
    });
    return () => { mounted = false; };
  }, [rpcName, previewPersonId]);
  return { rows, loading, error };
}

function ReadOnlyHeader({ title, count }: { title: string; count: number }) {
  return <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
    <div><h2 style={{ fontSize: 21, fontWeight: 700, margin: 0 }}>{title}</h2><p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--muted, #64748b)" }}>Company-wide, read-only access. Changes to records require an authorised administrator.</p></div>
    <strong style={{ fontSize: 13 }}>{count} records</strong>
  </header>;
}

export function CompanyDirectoryReadOnly({ previewPersonId }: { previewPersonId?: string }) {
  const { rows, loading, error } = useCompanyReadOnlyRows<CompanyDirectoryRow>("list_people_company_directory_readonly", previewPersonId);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => rows.filter((r) => [r.employee_name, r.company, r.department, r.job_title, r.work_location].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [rows, query]);
  return <section aria-label="Company-wide employee directory" style={{ padding: 14 }}>
    <ReadOnlyHeader title="Employee Directory" count={rows.length} />
    <label style={{ display: "block", marginBottom: 16, fontSize: 13 }}>Search employees
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, team, role, company or location" style={{ display: "block", width: "min(100%, 490px)", marginTop: 6, padding: 10, border: "1px solid var(--line, #cbd5e1)", borderRadius: 8, background: "var(--surface, #fff)", color: "inherit" }} />
    </label>
    {loading ? <p role="status">Loading employees…</p> : error ? <p role="alert">{error}</p> : filtered.length ? <SafeTable headings={["Employee", "Company", "Department", "Role", "Location", "Employment type", "Work email", "Phone"]}
      rows={filtered.map((r) => [r.employee_name, r.company, r.department, r.job_title, r.work_location.replaceAll("_", " "), r.employment_type.replaceAll("_", " "), r.work_email, r.work_phone])} /> : <p>No matching employees.</p>}
  </section>;
}

export function CompanyAssetsReadOnly({ previewPersonId }: { previewPersonId?: string }) {
  const { rows, loading, error } = useCompanyReadOnlyRows<CompanyAssetRow>("list_people_company_assets_readonly", previewPersonId);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => rows.filter((r) => [r.asset_code, r.asset_type, r.manufacturer, r.model, r.serial_number, r.assigned_person_name].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [rows, query]);
  return <section aria-label="Company-wide assets" style={{ padding: 14 }}>
    <ReadOnlyHeader title="Assets" count={rows.length} />
    <label style={{ display: "block", marginBottom: 16, fontSize: 13 }}>Search assets
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Asset, serial number or employee" style={{ display: "block", width: "min(100%, 490px)", marginTop: 6, padding: 10, border: "1px solid var(--line, #cbd5e1)", borderRadius: 8, background: "var(--surface, #fff)", color: "inherit" }} />
    </label>
    {loading ? <p role="status">Loading assets…</p> : error ? <p role="alert">{error}</p> : filtered.length ? <SafeTable headings={["Asset", "Type", "Make / model", "Serial number", "Status", "Assigned to", "Assigned on"]}
      rows={filtered.map((r) => [r.asset_code, r.asset_type, [r.manufacturer, r.model].filter(Boolean).join(" "), r.serial_number, r.asset_status, r.assigned_person_name, r.assigned_on])} /> : <p>No matching assets.</p>}
  </section>;
}
