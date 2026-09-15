import "server-only";

import { createHash } from "node:crypto";
import { basename } from "node:path";

import { strFromU8, unzipSync } from "fflate";
import readExcelFile, { type SheetData } from "read-excel-file/node";

export const PAYROLL_IMPORT_MAX_FILES = 4;
export const PAYROLL_IMPORT_MAX_FILE_BYTES = 500_000;
export const PAYROLL_IMPORT_MAX_TOTAL_BYTES = 900_000;
const MAX_SHEETS = 12;
const MAX_ROWS_PER_SHEET = 2_000;
const MAX_COLUMNS_PER_SHEET = 64;
const MAX_IMPORT_ROWS = 1_000;
const MAX_ARCHIVE_ENTRIES = 300;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 12_000_000;

export type PayrollCompany = "mam" | "equipsy";
export type PayrollBalanceKind = "annual" | "sick";

export type PayrollBalanceSourceRow = {
  companyKey: PayrollCompany;
  employeeName: string;
  annualHours: number | null;
  sickHours: number | null;
  asOf: string;
  sourceFile: string;
  sourceSha256: string;
};

export type PayrollBalanceSourceFile = {
  name: string;
  sha256: string;
  sizeBytes: number;
  companies: PayrollCompany[];
  asOfDates: string[];
  employeeRows: number;
};

export type ParsedPayrollBalanceUpload = {
  sourceDigest: string;
  files: PayrollBalanceSourceFile[];
  rows: PayrollBalanceSourceRow[];
};

type UploadFile = Pick<File, "name" | "size" | "type" | "arrayBuffer">;
type Sheet = { name: string; rows: SheetData };
type Observation = {
  companyKey: PayrollCompany;
  employeeName: string;
  kind: PayrollBalanceKind;
  hours: number;
  asOf: string;
  sourceFile: string;
  sourceSha256: string;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileName(value: string) {
  const cleaned = basename(value.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > 180) throw new Error("Choose a file with a shorter valid name.");
  return cleaned;
}

function normalText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalPersonName(value: string) {
  return normalText(value).replaceAll(" ", "");
}

function isoDate(year: number, month: number, day: number) {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2200 || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^as\s+(?:at|of)\s+/i, "").replace(/^balance\s+date\s*:?\s*/i, "");
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cleaned);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(cleaned);
  if (match) return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(cleaned);
  if (match) return isoDate(Number(match[3]), MONTHS[match[2].toLocaleLowerCase()] ?? 0, Number(match[1]));
  return null;
}

function parseCompany(value: unknown): PayrollCompany | null {
  if (typeof value !== "string") return null;
  const normal = normalText(value);
  if (/\bequipsy\b/.test(normal)) return "equipsy";
  if (/\bmam\b/.test(normal) || normal.includes("mobility access modifications")) return "mam";
  return null;
}

function parseLeaveKind(value: unknown): PayrollBalanceKind | null {
  if (typeof value !== "string") return null;
  const normal = normalText(value);
  if (normal.includes("annual") && normal.includes("leave")) return "annual";
  if ((normal.includes("sick") || normal.includes("personal") || normal.includes("carer")) && normal.includes("leave")) return "sick";
  return null;
}

function parseHours(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= -10_000 && value <= 100_000 ? value : null;
  if (typeof value !== "string") return null;
  let cleaned = value.trim().replace(/\s*hours?$/i, "").replaceAll(",", "");
  const negative = /^\(.*\)$/.test(cleaned);
  if (negative) cleaned = cleaned.slice(1, -1);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned) * (negative ? -1 : 1);
  return Number.isFinite(parsed) && parsed >= -10_000 && parsed <= 100_000 ? parsed : null;
}

function isEmployeeHeader(value: string) {
  return ["employee", "employee name", "staff", "staff name", "person", "person name", "team member", "name"].includes(value);
}

function isLeaveTypeHeader(value: string) {
  return ["leave type", "leave category", "category", "type"].includes(value);
}

function isUnitsHeader(value: string) {
  return ["units", "unit", "hours", "balance", "leave balance", "balance hours", "available balance", "available hours"].includes(value);
}

function isCompanyHeader(value: string) {
  return ["company", "company name", "entity", "organisation", "organization"].includes(value);
}

function isDateHeader(value: string) {
  return ["as at", "as of", "balance date", "snapshot date", "date"].includes(value);
}

type HeaderMap = {
  rowIndex: number;
  employee: number;
  leaveType: number | null;
  units: number | null;
  annual: number | null;
  sick: number | null;
  company: number | null;
  asOf: number | null;
};

function findHeader(rows: SheetData, sheetName: string, fileName: string): HeaderMap {
  let best: { score: number; map: HeaderMap } | null = null;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 25); rowIndex += 1) {
    const headers = rows[rowIndex].map((value) => typeof value === "string" ? normalText(value) : "");
    const employee = headers.findIndex(isEmployeeHeader);
    if (employee < 0) continue;
    const leaveType = headers.findIndex(isLeaveTypeHeader);
    const units = headers.findIndex(isUnitsHeader);
    const annual = headers.findIndex((value) => parseLeaveKind(value) === "annual");
    const sick = headers.findIndex((value) => parseLeaveKind(value) === "sick");
    const company = headers.findIndex(isCompanyHeader);
    const asOf = headers.findIndex(isDateHeader);
    const tidy = units >= 0 && (leaveType >= 0 || parseLeaveKind(sheetName) !== null || parseLeaveKind(fileName) !== null);
    const wide = annual >= 0 || sick >= 0;
    if (!tidy && !wide) continue;
    const score = 10 + Number(leaveType >= 0) * 3 + Number(units >= 0) * 3 + Number(annual >= 0) * 2 + Number(sick >= 0) * 2 + Number(company >= 0) + Number(asOf >= 0);
    const map: HeaderMap = {
      rowIndex,
      employee,
      leaveType: leaveType >= 0 ? leaveType : null,
      units: units >= 0 ? units : null,
      annual: annual >= 0 ? annual : null,
      sick: sick >= 0 ? sick : null,
      company: company >= 0 ? company : null,
      asOf: asOf >= 0 ? asOf : null,
    };
    if (!best || score > best.score) best = { score, map };
  }
  if (!best) throw new Error(`${fileName} · ${sheetName}: could not find employee and leave-balance columns.`);
  return best.map;
}

function inferSheetValue<T>(rows: SheetData, headerRowIndex: number, parser: (value: unknown) => T | null, fallback?: string) {
  for (const row of rows.slice(0, headerRowIndex)) {
    for (const cell of row) {
      const value = parser(cell);
      if (value !== null) return value;
    }
  }
  return fallback ? parser(fallback) : null;
}

function dataRowHasValue(row: SheetData[number]) {
  return row.some((cell) => cell !== null && cell !== undefined && cell !== "");
}

function parseSheet(sheet: Sheet, fileName: string, fileSha256: string): Observation[] {
  if (sheet.rows.length > MAX_ROWS_PER_SHEET) throw new Error(`${fileName} · ${sheet.name}: too many rows.`);
  if (sheet.rows.some((row) => row.length > MAX_COLUMNS_PER_SHEET)) throw new Error(`${fileName} · ${sheet.name}: too many columns.`);
  const header = findHeader(sheet.rows, sheet.name, fileName);
  const sheetCompany = inferSheetValue(sheet.rows, header.rowIndex, parseCompany, fileName);
  const sheetAsOf = inferSheetValue(sheet.rows, header.rowIndex, parseDate);
  const sheetKind = parseLeaveKind(sheet.name) ?? parseLeaveKind(fileName);
  const observations: Observation[] = [];

  for (let rowIndex = header.rowIndex + 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex];
    if (!dataRowHasValue(row)) continue;
    const rawName = row[header.employee];
    if (typeof rawName !== "string" || !normalPersonName(rawName)) {
      throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: employee name is missing or invalid.`);
    }
    const employeeName = rawName.replace(/\s+/g, " ").trim();
    if (employeeName.length > 200) throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: employee name is too long.`);
    const companyKey = (header.company === null ? null : parseCompany(row[header.company])) ?? sheetCompany;
    const asOf = (header.asOf === null ? null : parseDate(row[header.asOf])) ?? sheetAsOf;
    if (!companyKey) throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: company could not be identified.`);
    if (!asOf) throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: balance date could not be identified.`);

    if (header.annual !== null || header.sick !== null) {
      for (const [kind, column] of [["annual", header.annual], ["sick", header.sick]] as const) {
        if (column === null || row[column] === null || row[column] === undefined || row[column] === "") continue;
        const hours = parseHours(row[column]);
        if (hours === null) throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: ${kind} leave balance is invalid.`);
        observations.push({ companyKey, employeeName, kind, hours, asOf, sourceFile: fileName, sourceSha256: fileSha256 });
      }
      continue;
    }

    const kind = (header.leaveType === null ? null : parseLeaveKind(row[header.leaveType])) ?? sheetKind;
    const hours = header.units === null ? null : parseHours(row[header.units]);
    if (!kind) throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: leave type is not recognised.`);
    if (hours === null) throw new Error(`${fileName} · ${sheet.name} · row ${rowIndex + 1}: leave balance is invalid.`);
    observations.push({ companyKey, employeeName, kind, hours, asOf, sourceFile: fileName, sourceSha256: fileSha256 });
  }
  if (!observations.length) throw new Error(`${fileName} · ${sheet.name}: no leave balances were found.`);
  return observations;
}

function parseCsv(text: string, fileName: string): SheetData {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field) throw new Error(`${fileName}: CSV quoting is invalid.`);
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(`${fileName}: CSV has an unfinished quoted field.`);
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > MAX_ROWS_PER_SHEET) throw new Error(`${fileName}: too many rows.`);
  if (rows.some((values) => values.length > MAX_COLUMNS_PER_SHEET)) throw new Error(`${fileName}: too many columns.`);
  return rows.map((values) => values.map((value) => value.trim() || null));
}

function validateXlsxArchive(buffer: Buffer, fileName: string) {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error(`${fileName}: Excel archive is invalid.`);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (entryCount < 1 || entryCount > MAX_ARCHIVE_ENTRIES || centralOffset + centralSize > bytes.byteLength) {
    throw new Error(`${fileName}: Excel archive is too large or invalid.`);
  }
  let offset = centralOffset;
  let totalUncompressed = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error(`${fileName}: Excel archive is invalid.`);
    const flags = view.getUint16(offset + 8, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 1) !== 0 || uncompressedSize === 0xffffffff) throw new Error(`${fileName}: encrypted or ZIP64 Excel files are not supported.`);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error(`${fileName}: Excel archive is invalid.`);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameStart, nameEnd));
    if (!name || name.startsWith("/") || name.includes("..") || name.includes("\\") || names.has(name)) throw new Error(`${fileName}: Excel archive contains an unsafe entry.`);
    names.add(name);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`${fileName}: expanded Excel data is too large.`);
    offset = nameEnd + extraLength + commentLength;
  }
  if (!names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) throw new Error(`${fileName}: this is not a valid .xlsx workbook.`);
  if ([...names].some((name) => /(?:vbaProject\.bin|xl\/externalLinks\/)/i.test(name))) {
    throw new Error(`${fileName}: macros and external workbook links are not supported.`);
  }
  const archive = unzipSync(bytes);
  for (const [name, content] of Object.entries(archive)) {
    if (/^xl\/worksheets\/.*\.xml$/i.test(name) && /<(?:\w+:)?f(?:\s|>)/i.test(strFromU8(content))) {
      throw new Error(`${fileName}: formula-driven balance cells are not supported. Export values only.`);
    }
  }
}

async function sheetsFromFile(file: UploadFile, name: string, buffer: Buffer): Promise<Sheet[]> {
  const extension = name.slice(name.lastIndexOf(".")).toLocaleLowerCase();
  if (extension === ".csv") {
    if (file.type && !["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"].includes(file.type)) {
      throw new Error(`${name}: file type does not match a CSV upload.`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
      throw new Error(`${name}: CSV must use UTF-8 text.`);
    }
    if (text.includes("\u0000")) throw new Error(`${name}: CSV contains binary data.`);
    return [{ name: name.replace(/\.csv$/i, ""), rows: parseCsv(text, name) }];
  }
  if (extension !== ".xlsx") throw new Error(`${name}: upload a .csv or .xlsx file.`);
  if (file.type && ![
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
    "application/zip",
  ].includes(file.type)) throw new Error(`${name}: file type does not match an Excel workbook.`);
  validateXlsxArchive(buffer, name);
  const workbook = await readExcelFile(buffer);
  if (!workbook.length || workbook.length > MAX_SHEETS) throw new Error(`${name}: workbook has too many sheets or no readable sheet.`);
  return workbook.map((sheet) => ({ name: sheet.sheet, rows: sheet.data }));
}

function groupObservations(observations: Observation[]): PayrollBalanceSourceRow[] {
  type Group = Omit<PayrollBalanceSourceRow, "annualHours" | "sickHours" | "sourceFile" | "sourceSha256"> & {
    annualHours: number | null;
    sickHours: number | null;
    sourceFiles: Set<string>;
    sourceHashes: Set<string>;
  };
  const groups = new Map<string, Group>();
  for (const item of observations) {
    const key = [item.companyKey, normalPersonName(item.employeeName), item.asOf].join(":");
    let group = groups.get(key);
    if (!group) {
      group = {
        companyKey: item.companyKey,
        employeeName: item.employeeName,
        annualHours: null,
        sickHours: null,
        asOf: item.asOf,
        sourceFiles: new Set(),
        sourceHashes: new Set(),
      };
      groups.set(key, group);
    }
    const field = item.kind === "annual" ? "annualHours" : "sickHours";
    if (group[field] !== null && group[field] !== item.hours) {
      throw new Error(`${item.employeeName} has conflicting ${item.kind} leave balances for ${item.asOf}.`);
    }
    group[field] = item.hours;
    group.sourceFiles.add(item.sourceFile);
    group.sourceHashes.add(item.sourceSha256);
  }
  if (!groups.size || groups.size > MAX_IMPORT_ROWS) throw new Error("The upload has too many employee balance rows or no valid balances.");
  return [...groups.values()].map((group) => ({
    companyKey: group.companyKey,
    employeeName: group.employeeName,
    annualHours: group.annualHours,
    sickHours: group.sickHours,
    asOf: group.asOf,
    sourceFile: [...group.sourceFiles].sort().join(", "),
    sourceSha256: sha256([...group.sourceHashes].sort().join(":")),
  })).sort((left, right) => left.companyKey.localeCompare(right.companyKey) || left.employeeName.localeCompare(right.employeeName, "en-AU", { sensitivity: "base" }));
}

export async function parsePayrollBalanceFiles(files: UploadFile[]): Promise<ParsedPayrollBalanceUpload> {
  if (!Array.isArray(files) || files.length < 1 || files.length > PAYROLL_IMPORT_MAX_FILES) {
    throw new Error(`Choose between 1 and ${PAYROLL_IMPORT_MAX_FILES} CSV or Excel files.`);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > PAYROLL_IMPORT_MAX_TOTAL_BYTES) throw new Error("The selected files are too large to import together.");
  const observations: Observation[] = [];
  const summaries: PayrollBalanceSourceFile[] = [];

  for (const file of files) {
    const name = safeFileName(file.name);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > PAYROLL_IMPORT_MAX_FILE_BYTES) {
      throw new Error(`${name}: file must be smaller than ${Math.round(PAYROLL_IMPORT_MAX_FILE_BYTES / 1_000)} KB.`);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength !== file.size) throw new Error(`${name}: file size changed during upload.`);
    const fileSha256 = sha256(buffer);
    const sheets = await sheetsFromFile(file, name, buffer);
    const fileObservations = sheets.flatMap((sheet) => parseSheet(sheet, name, fileSha256));
    observations.push(...fileObservations);
    summaries.push({
      name,
      sha256: fileSha256,
      sizeBytes: file.size,
      companies: [...new Set(fileObservations.map((row) => row.companyKey))].sort(),
      asOfDates: [...new Set(fileObservations.map((row) => row.asOf))].sort(),
      employeeRows: new Set(fileObservations.map((row) => [row.companyKey, normalPersonName(row.employeeName), row.asOf].join(":"))).size,
    });
  }

  return {
    sourceDigest: sha256(summaries.map((file) => `${file.name}:${file.sha256}`).sort().join("|")),
    files: summaries,
    rows: groupObservations(observations),
  };
}
