import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { equalDigest, quoteDigest } from "../commerce/guest.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";

export const exchangeLimit = 128 * 1024;
export const exchangeRowLimit = 150;
export type ExchangeIssue = { row: number; message: string };
export type ExchangeEntry = { key: string; name: string; rows: number[]; status: "New" | "Unchanged" };
export type ExchangeResult = { key: string; rows: number[]; status: "Created" | "Unchanged" | "Failed"; message?: string };

export function csvRows<const Headers extends readonly string[]>(csv: string, columns: Headers) {
  const issues: ExchangeIssue[] = [];
  const rows: { line: number; fields: Record<Headers[number], string> }[] = [];
  if (Buffer.byteLength(csv) > exchangeLimit) return { issues: [{ row: 1, message: "Choose a UTF-8 CSV up to 128 KB." }], rows };
  let entries: { record: string[]; info: { lines: number } }[];
  try {
    entries = parse(csv, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true, info: true,
      record_delimiter: ["\r\n", "\n", "\r"], max_record_size: 12000 }) as unknown as typeof entries;
  } catch (error) {
    const row = error && typeof error === "object" && "lines" in error && typeof error.lines === "number" ? error.lines : 1;
    return { issues: [{ row, message: "Malformed CSV. Check separators and quotation marks." }], rows };
  }
  const header = entries.shift()?.record;
  if (!header || header.length !== columns.length || new Set(header).size !== columns.length || !columns.every(name => header.includes(name))) {
    return { issues: [{ row: 1, message: "Use the exact column names in the template." }], rows };
  }
  if (!entries.length || entries.length > exchangeRowLimit) {
    return { issues: [{ row: 1, message: "Select a CSV containing 1–150 data rows." }], rows };
  }
  for (const { record, info } of entries) {
    if (record.length !== header.length) {
      issues.push({ row: info.lines, message: "This row has a different number of fields from the header." });
      continue;
    }
    rows.push({ line: info.lines, fields: Object.fromEntries(header.map((key, index) => {
      const value = record[index];
      return [key, /^'\s*['=+\-@\t\r\n]/u.test(value) ? value.slice(1) : value];
    })) as Record<Headers[number], string> });
  }
  return { issues, rows };
}

export function exchangeCsv(columns: readonly string[], rows: readonly (readonly (string | number | null)[])[] = []) {
  const cell = (value: string | number | null) => {
    const text = String(value ?? "");
    const escaped = /^\s*['=+\-@\t\r\n]/u.test(text) ? "'" + text : text;
    return `"${escaped.replaceAll('"', '""')}"`;
  };
  return [columns, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function exchangeToken(actorId: string, scope: string, csv: string) {
  const fileHash = createHash("sha256").update(csv).digest("hex");
  return quoteDigest(JSON.stringify(["catalog-exchange", scope, actorId, fileHash]));
}

export function requireExchangeConfirmation(candidate: string, expected: string, issues: ExchangeIssue[]) {
  if (!equalDigest(candidate, expected) || issues.length) {
    throw new CatalogWriteError("conflict", "Preview the current file and resolve every reported issue before importing.");
  }
}

