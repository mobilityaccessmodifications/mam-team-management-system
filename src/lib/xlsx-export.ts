import "server-only";

type WorkbookSheet = {
  name: string;
  rows: readonly (readonly string[])[];
};

type ZipFile = {
  name: string;
  contents: Uint8Array;
};

const textEncoder = new TextEncoder();
// ZIP's DOS timestamp epoch is 1980-01-01. A zero date encodes month/day 0
// and is rejected by strict archive readers even though Excel tolerates it.
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = (1 << 5) | 1;

function encode(value: string) {
  return textEncoder.encode(value);
}

function concat(chunks: readonly Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function uint16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: readonly ZipFile[]) {
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const fileName = encode(file.name);
    const checksum = crc32(file.contents);
    const localHeader = concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(ZIP_DOS_TIME),
      uint16(ZIP_DOS_DATE),
      uint32(checksum),
      uint32(file.contents.length),
      uint32(file.contents.length),
      uint16(fileName.length),
      uint16(0),
      fileName,
    ]);
    localRecords.push(localHeader, file.contents);

    centralRecords.push(concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(ZIP_DOS_TIME),
      uint16(ZIP_DOS_DATE),
      uint32(checksum),
      uint32(file.contents.length),
      uint32(file.contents.length),
      uint16(fileName.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      fileName,
    ]));
    offset += localHeader.length + file.contents.length;
  }

  const centralDirectory = concat(centralRecords);
  return concat([
    ...localRecords,
    centralDirectory,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(centralDirectory.length),
    uint32(offset),
    uint16(0),
  ]);
}

function escapeXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  }[character] ?? character));
}

function spreadsheetColumn(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function inlineStringCell(reference: string, value: string) {
  const escaped = escapeXml(value);
  const preserveWhitespace = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" t="inlineStr"><is><t${preserveWhitespace}>${escaped}</t></is></c>`;
}

function worksheetXml(rows: readonly (readonly string[])[]) {
  const rowsXml = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => inlineStringCell(
      `${spreadsheetColumn(columnIndex)}${rowNumber}`,
      value,
    )).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

function safeSheetName(name: string, fallbackIndex: number) {
  const normalized = name.replace(/[\\/*?:\[\]]/g, " ").trim().slice(0, 31);
  return normalized || `Sheet ${fallbackIndex + 1}`;
}

/**
 * Builds a compact XLSX workbook using inline strings only. Treating every
 * value as text prevents spreadsheet formula execution when HR-provided data
 * happens to start with a formula character.
 */
export function buildXlsxWorkbook(sheets: readonly WorkbookSheet[]): Uint8Array {
  if (!sheets.length) throw new Error("An Excel export needs at least one sheet.");

  const preparedSheets = sheets.map((sheet, index) => ({
    name: safeSheetName(sheet.name, index),
    rows: sheet.rows,
    fileName: `xl/worksheets/sheet${index + 1}.xml`,
  }));

  const workbookSheets = preparedSheets.map((sheet, index) => (
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join("");
  const workbookRelationships = preparedSheets.map((sheet, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${sheet.fileName.split("/").at(-1)}"/>`
  )).join("");
  const sheetContentTypes = preparedSheets.map((sheet) => (
    `<Override PartName="/${sheet.fileName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join("");

  return zip([
    {
      name: "[Content_Types].xml",
      contents: encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetContentTypes}
</Types>`),
    },
    {
      name: "_rels/.rels",
      contents: encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      contents: encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      contents: encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}</Relationships>`),
    },
    ...preparedSheets.map((sheet) => ({
      name: sheet.fileName,
      contents: encode(worksheetXml(sheet.rows)),
    })),
  ]);
}
