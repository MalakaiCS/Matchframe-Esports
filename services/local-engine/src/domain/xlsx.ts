import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * A small .xlsx reader and writer (Office Open XML spreadsheets) on fflate, for the team and player
 * imports: the first worksheet's cells as text with their stored type, and simple one-row-header
 * sheets for the downloadable templates. No formulas, styles beyond bold headers and Text columns,
 * or macros. Uploaded files are untrusted: sizes are capped and XML is read with plain scanning
 * (no entity expansion).
 */

export const XLSX_MAX_BYTES = 5 * 1024 * 1024;
const MAX_UNZIPPED = 40 * 1024 * 1024;
export const XLSX_MAX_ROWS = 5000;

export class XlsxError extends Error {
  readonly status = 400;
  readonly code = "bad_xlsx";
}

export interface XlsxCell {
  /** The cell as text ("" when empty). */
  text: string;
  /** "s" text, "n" number, "b" boolean, "e" error, "d" date, "" empty. */
  type: "s" | "n" | "b" | "e" | "d" | "";
}

export interface XlsxRow {
  /** Spreadsheet row number (1-based, as Excel shows it). */
  row: number;
  cells: XlsxCell[];
}

const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });

const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decode(m[2]!);
  return out;
}

/** Text of a shared string or inline string: its <t> runs, leaving out phonetic hints (<rPh>). */
function runText(xml: string): string {
  const noPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of noPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += decode(m[1] ?? "");
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unzip(body: Buffer): Record<string, Uint8Array> {
  if (body.length > XLSX_MAX_BYTES) throw new XlsxError(`The spreadsheet is ${(body.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
  if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) throw new XlsxError("This is not an .xlsx file. Save the spreadsheet as Excel Workbook (.xlsx) and upload it again (.xls and .csv are not accepted here).");
  let total = 0;
  try {
    return unzipSync(new Uint8Array(body), {
      filter: (f) => {
        const want = f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name);
        if (!want) return false;
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new XlsxError("The spreadsheet is too large once unpacked.");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError("The .xlsx file is damaged and could not be opened.");
  }
}

/** The first worksheet's rows (empty rows left out), each cell's text and type. */
export function readXlsx(body: Buffer): XlsxRow[] {
  const files = unzip(body);
  const wb = files["xl/workbook.xml"];
  if (!wb) throw new XlsxError("The .xlsx file has no workbook.");
  const firstSheet = /<sheet\b([^>]*)\/?>/.exec(strFromU8(wb));
  if (!firstSheet) throw new XlsxError("The workbook has no worksheets.");
  const relId = attrs(firstSheet[1]!)["r:id"];
  let path = "xl/worksheets/sheet1.xml";
  const rels = files["xl/_rels/workbook.xml.rels"];
  if (relId && rels) {
    for (const m of strFromU8(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const a = attrs(m[1]!);
      if (a.Id === relId && a.Target) path = a.Target.startsWith("/") ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, "")}`;
    }
  }
  const sheet = files[path];
  if (!sheet) throw new XlsxError("The first worksheet is missing from the .xlsx file.");
  const shared: string[] = [];
  const ss = files["xl/sharedStrings.xml"];
  if (ss) for (const m of strFromU8(ss).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(runText(m[1]!));
  const rows: XlsxRow[] = [];
  let auto = 0;
  for (const rm of strFromU8(sheet).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(attrs(rm[1]!).r) || auto + 1;
    auto = rowNo;
    const cells: XlsxCell[] = [];
    let col = -1;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]!);
      col = a.r ? colIndex(a.r) : col + 1;
      const inner = cm[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let cell: XlsxCell;
      switch (a.t) {
        case "s":
          cell = { text: shared[Number(v)] ?? "", type: "s" };
          break;
        case "inlineStr":
          cell = { text: runText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? ""), type: "s" };
          break;
        case "str":
          cell = { text: decode(v ?? ""), type: "s" };
          break;
        case "b":
          cell = { text: v === "1" ? "TRUE" : "FALSE", type: "b" };
          break;
        case "e":
          cell = { text: decode(v ?? ""), type: "e" };
          break;
        case "d":
          cell = { text: decode(v ?? ""), type: "d" };
          break;
        default:
          cell = v === undefined ? { text: "", type: "" } : { text: decode(v), type: "n" };
      }
      if (col >= 0 && col < 200) cells[col] = cell;
    }
    for (let i = 0; i < cells.length; i++) cells[i] ??= { text: "", type: "" };
    if (cells.some((c) => c.text.trim() !== "")) rows.push({ row: rowNo, cells });
    if (rows.length > XLSX_MAX_ROWS + 1) throw new XlsxError(`The spreadsheet has more than ${XLSX_MAX_ROWS} rows; split it into smaller files.`);
  }
  return rows;
}

export interface SheetSpec {
  name: string;
  columns: { header: string; width: number; text?: boolean }[];
  rows?: string[][];
}

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(spec: SheetSpec): string {
  // Styles: 0 default, 1 text (@), 2 bold header.
  const cols = spec.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"${c.text ? ' style="1"' : ""}/>`).join("");
  const cell = (r: number, c: number, v: string, style: number) => `<c r="${colName(c)}${r}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${encode(v)}</t></is></c>`;
  const header = `<row r="1">${spec.columns.map((c, i) => cell(1, i, c.header, 2)).join("")}</row>`;
  const body = (spec.rows ?? []).map((row, ri) => `<row r="${ri + 2}">${row.map((v, ci) => cell(ri + 2, ci, v, spec.columns[ci]?.text ? 1 : 0)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${header}${body}</sheetData></worksheet>`;
}

/** Writes a workbook with one sheet per spec (header row bold and frozen; Text columns keep long numbers such as SteamIDs exact). */
export function writeXlsx(sheets: SheetSpec[]): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${encode(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return Buffer.from(zipSync(files, { level: 6 }));
}
