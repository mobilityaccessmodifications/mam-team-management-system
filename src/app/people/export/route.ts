import { listEmployeeDirectoryRecordsForManager } from "@/lib/employee-directory";
import type { EmployeeDirectoryRecord } from "@/lib/employee-directory-types";

export const dynamic = "force-dynamic";

const headers = [
  "First Name",
  "Last Name",
  "Work Email",
  "Personal Email",
  "Phone",
  "Job Title",
  "Team",
  "Company",
  "Manager",
  "Country",
  "Date of birth",
  "Start date",
  "Scheduled Employment End Date",
  "Employment Status",
  "Archive Reason",
  "Laptop supplied",
  "Laptop ID",
  "Mouse ID",
  "Keyboard ID",
  "Asset Tags",
];

function laptopSuppliedLabel(value: EmployeeDirectoryRecord["laptopSupplied"]) {
  if (value === "own_laptop") return "Own Laptop";
  if (value === "mam_laptop") return "MAM Laptop";
  return "Not recorded";
}

function safeCsvCell(value: string) {
  const escaped = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(escaped) ? `"${escaped.replaceAll('"', '""')}"` : escaped;
}

function toCsvRow(record: EmployeeDirectoryRecord) {
  return [
    record.firstName,
    record.lastName,
    record.workEmail,
    record.personalEmail,
    record.phone,
    record.positionTitle,
    record.teamName,
    record.company === "equipsy" ? "Equipsy" : "MAM",
    record.managerName,
    record.country,
    record.dateOfBirth,
    record.startedDate,
    record.scheduledEmploymentEndDate,
    record.isActive ? "Active" : "Archived",
    record.archiveReason,
    laptopSuppliedLabel(record.laptopSupplied),
    record.laptopId,
    record.mouseId,
    record.keyboardId,
    record.assetTags.join("; "),
  ].map(safeCsvCell).join(",");
}

function filenameDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET() {
  try {
    const records = await listEmployeeDirectoryRecordsForManager();
    const contents = `\uFEFF${headers.map(safeCsvCell).join(",")}\r\n${records.map(toCsvRow).join("\r\n")}\r\n`;

    return new Response(contents, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="People Hub Employees ${filenameDate()}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not authorised.", {
      status: 403,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
