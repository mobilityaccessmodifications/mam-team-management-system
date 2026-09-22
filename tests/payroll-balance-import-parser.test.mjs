import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const moduleUnderTest = { exports: {} };
const source = ts.transpileModule(
  readFileSync("src/lib/payroll-balance-import.ts", "utf8"),
  {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function testRequire(id) {
  if (id === "server-only") return {};
  return require(id);
}

new Function("require", "module", "exports", source)(testRequire, moduleUnderTest, moduleUnderTest.exports);
const {
  parsePayrollBalanceFiles,
  parsePreparedPayrollBalanceFiles,
  preparePayrollBalanceFiles,
} = moduleUnderTest.exports;

function upload(name, contents, type = "text/csv") {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  return {
    name,
    size: bytes.byteLength,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

// A real, values-only OOXML workbook exercises read-excel-file and parseSheet.
function xlsx(rows, sheetName = "Annual leave") {
  const { strToU8, zipSync } = require("fflate");
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const data = rows.map((row, index) => `<row r="${index + 1}">${row.map((cell, column) =>
    cell == null ? "" : `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${escape(cell)}</t></is></c>`
  ).join("")}</row>`).join("");
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
  }).map(([path, xml]) => [path, strToU8(xml)]))));
}

for (const extension of ["csv", "xlsx"]) {
  const tidyFile = (kind, includeColumn = true) => {
    const rows = [
      ["Company", "Employee", "As of", "Hours", ...(includeColumn ? ["Leave Type"] : [])],
      ["MAM", "Synthetic Employee", "2026-09-10", "12", ...(includeColumn ? [kind] : [])],
    ];
    return extension === "csv"
      ? upload("mam-annual-leave.csv", rows.map((row) => row.join(",")).join("\n"))
      : upload("mam-annual-leave.xlsx", xlsx(rows), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  };

  test(`${extension}: explicit unsupported categories cannot inherit a filename or sheet category`, async () => {
    for (const kind of ["Unpaid leave", "Long service leave", "Unknown category", "42"]) {
      await assert.rejects(parsePayrollBalanceFiles([tidyFile(kind)]), /row 2: leave type is not recognised/);
    }
  });

  test(`${extension}: missing and blank categories may inherit a filename or sheet category`, async () => {
    for (const file of [tidyFile("", false), tidyFile(null), tidyFile("   ")]) {
      const result = await parsePayrollBalanceFiles([file]);
      assert.equal(result.rows[0].annualHours, 12);
      assert.equal(result.rows[0].sickHours, null);
    }
  });

  test(`${extension}: an explicit supported category wins over filename and sheet hints`, async () => {
    const result = await parsePayrollBalanceFiles([tidyFile("Sick Leave Accrual")]);
    assert.equal(result.rows[0].annualHours, null);
    assert.equal(result.rows[0].sickHours, 12);
  });
}

test("prepares one canonical private archive payload and parses the same buffered bytes", async () => {
  let reads = 0;
  const file = upload("mam-balances.csv", [
    "Company,Employee,As of,Annual Leave",
    "MAM,Sample Person,2026-09-10,14.25",
  ].join("\n"), "application/octet-stream");
  const originalRead = file.arrayBuffer;
  file.arrayBuffer = async () => {
    reads += 1;
    return originalRead();
  };

  const prepared = await preparePayrollBalanceFiles([file]);
  assert.equal(reads, 1);
  assert.equal(prepared[0].mimeType, "text/csv");
  assert.match(prepared[0].sha256, /^[0-9a-f]{64}$/);
  const result = await parsePreparedPayrollBalanceFiles(prepared);
  assert.equal(reads, 1);
  assert.equal(result.rows[0].annualHours, 14.25);
});

test("combines split payroll exports and understands tidy and wide company layouts", async () => {
  const annual = upload("Mobility_Access_Modifications_Annual.csv", [
    "Leave Balances",
    "Mobility Access Modifications Pty Ltd",
    "As at 10 September 2026",
    "",
    "Employee,Leave Type,Units",
    '"Sample, Ada",Annual Leave Accrual,51.3552',
  ].join("\n"));
  const sick = upload("Mobility_Access_Modifications_Sick.csv", [
    "Leave Balances",
    "Mobility Access Modifications Pty Ltd",
    "As at 10 September 2026",
    "",
    "Employee,Leave Type,Units",
    '"Sample, Ada",Sick Leave Accrual,80.7246',
  ].join("\n"));
  const equipsy = upload("equipsy-balances.csv", [
    "Company,Employee,As of,Annual Leave,Personal (Sick/Carer's) Leave",
    "Equipsy Pty Ltd,Sample Person,10/09/2026,12.5,3.25",
  ].join("\n"));

  const result = await parsePayrollBalanceFiles([annual, sick, equipsy]);
  assert.equal(result.files.length, 3);
  assert.match(result.sourceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.rows.map((row) => ({
    company: row.companyKey,
    employee: row.employeeName,
    annual: row.annualHours,
    sick: row.sickHours,
    asOf: row.asOf,
  })), [
    { company: "equipsy", employee: "Sample Person", annual: 12.5, sick: 3.25, asOf: "2026-09-10" },
    { company: "mam", employee: "Sample, Ada", annual: 51.3552, sick: 80.7246, asOf: "2026-09-10" },
  ]);
  assert.equal(result.rows[1].sourceFile, "Mobility_Access_Modifications_Annual.csv, Mobility_Access_Modifications_Sick.csv");
});

test("rejects conflicting balances rather than guessing which source wins", async () => {
  const first = upload("mam-annual-one.csv", "Company,Employee,As of,Annual Leave\nMAM,Sample Person,2026-09-10,10");
  const second = upload("mam-annual-two.csv", "Company,Employee,As of,Annual Leave\nMAM,Sample Person,2026-09-10,11");
  await assert.rejects(
    parsePayrollBalanceFiles([first, second]),
    /conflicting annual leave balances/i,
  );
});

test("rejects explicit invalid company and date cells instead of replacing them with file defaults", async () => {
  const invalidCompany = upload("mam-balances.csv", [
    "As at 10 September 2026",
    "Company,Employee,As of,Annual Leave",
    "Unrecognised Entity,Sample Person,2026-09-10,10",
  ].join("\n"));
  await assert.rejects(
    parsePayrollBalanceFiles([invalidCompany]),
    /company is not recognised/i,
  );

  const invalidDate = upload("mam-balances.csv", [
    "As at 10 September 2026",
    "Company,Employee,As of,Annual Leave",
    "MAM,Sample Person,31\/02\/2026,10",
  ].join("\n"));
  await assert.rejects(
    parsePayrollBalanceFiles([invalidDate]),
    /balance date is invalid/i,
  );
});

test("groups Unicode-equivalent employee names without dropping non-Latin letters", async () => {
  const annual = upload("mam-unicode-annual.csv", [
    "Company,Employee,As of,Annual Leave",
    "MAM,Māori 李,2026-09-10,14.25",
  ].join("\n"));
  const sick = upload("mam-unicode-sick.csv", [
    "Company,Employee,As of,Sick Leave",
    "MAM,Maori 李,2026-09-10,7.5",
  ].join("\n"));

  const result = await parsePayrollBalanceFiles([annual, sick]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].employeeName, "Māori 李");
  assert.equal(result.rows[0].annualHours, 14.25);
  assert.equal(result.rows[0].sickHours, 7.5);
});

test("keeps a grouped row valid when four allowed filenames have the maximum length", async () => {
  const names = ["a", "b", "c", "d"].map((prefix) => `${prefix}${"x".repeat(175)}.csv`);
  const files = names.map((name, index) => upload(name, [
    "Company,Employee,As of,Annual Leave",
    "MAM,Long Filename Person,2026-09-10,14.25",
    "".padEnd(index, " "),
  ].join("\n")));

  const result = await parsePayrollBalanceFiles(files);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sourceFile.length, 726);
});

test("rejects formula-driven Excel workbooks before workbook values are parsed", async () => {
  const { strToU8, zipSync } = require("fflate");
  const workbook = Buffer.from(zipSync({
    "[Content_Types].xml": strToU8("<Types/>") ,
    "xl/workbook.xml": strToU8("<workbook/>") ,
    "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData><row><c><f>1+1</f><v>2</v></c></row></sheetData></worksheet>"),
  }));
  await assert.rejects(
    parsePayrollBalanceFiles([upload("mam-formula.xlsx", workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")]),
    /formula-driven balance cells are not supported/i,
  );
});

test("rejects unsafe Excel archive paths and oversized upload sets", async () => {
  const { strToU8, zipSync } = require("fflate");
  const unsafe = Buffer.from(zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8("<workbook/>"),
    "../outside.xml": strToU8("<unsafe/>"),
  }));
  await assert.rejects(
    parsePayrollBalanceFiles([upload("unsafe.xlsx", unsafe, "application/zip")]),
    /unsafe entry/i,
  );

  const tooLarge = {
    name: "mam-balances.csv",
    size: 500_001,
    type: "text/csv",
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
  await assert.rejects(parsePayrollBalanceFiles([tooLarge]), /smaller than 500 KB/i);
});
