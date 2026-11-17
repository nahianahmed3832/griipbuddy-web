import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { getDb } from "../db/client.ts";
import { equalDigest, quoteDigest } from "../commerce/guest.ts";
import { previewProduct, saveProduct } from "./catalog.ts";
import { productIdField, type ProductInput, type VariantInput } from "./catalog-input.ts";
import { authorize, OperationError } from "./operations.ts";
import { reportFailure } from "../db/observability.ts";
import { markets } from "../../config/markets.ts";

export const csvLimit = 256 * 1024;
const productColumns = [
  "product_id", "slug", "name", "category_id", "description", "attributes_json", "keywords", "collection_ids",
  "gallery_json", "publication", "demo", "featured", "new_arrival",
] as const;
const columns = [
  ...productColumns, "sku", "options_json", "variant_active", "variant_image", "variant_alt",
  "bd_price_minor", "bd_currency", "bd_eligible", "us_price_minor", "us_currency", "us_eligible",
] as const;
type CsvRow = Record<typeof columns[number], string>;
type Entry = { record: string[]; info: { lines: number } };
type Issue = { row: number; message: string };
export type CatalogConflict = { row: number; field: string; earlier: string; incoming: string };
type Group = { product: ProductInput; rows: number[]; productKey: string; conflicts: CatalogConflict[]; duplicates: number[] };
export type ImportEntry = { id: string; name: string; rows: number[]; skus: string[]; status: "New" | "Update" | "Unchanged" };
export type ImportPreview = { issues: Issue[]; entries: ImportEntry[]; token?: string };
export type ImportResult = { id: string; status: "New" | "Update" | "Unchanged" | "Failed"; message?: string };

function bool(value: string, field: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new OperationError(`${field} must be true or false.`);
}

function json(value: string, field: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new OperationError(`${field} contains invalid JSON.`);
  }
}

function parseVariant(row: CsvRow): VariantInput {
  const offers = (["bd", "us"] as const).flatMap((marketId) => {
    const amount = row[`${marketId}_price_minor`];
    const currency = markets[marketId].currency;
    const eligible = row[`${marketId}_eligible`];
    if (!amount && !row[`${marketId}_currency`] && !eligible) return [];
    if (!/^\d{1,8}$/.test(amount)) throw new OperationError(`${marketId}_price_minor must be an integer in minor units.`);
    if (row[`${marketId}_currency`] !== currency) {
      throw new OperationError(`${marketId}_currency must be ${currency}.`);
    }
    return [{ marketId, amountMinor: Number(amount), currency, eligible: bool(eligible, `${marketId}_eligible`) }];
  });
  return {
    sku: row.sku, options: json(row.options_json, "options_json"), active: bool(row.variant_active, "variant_active"), offers,
    ...(row.variant_image || row.variant_alt ? { image: { src: row.variant_image, alt: row.variant_alt } } : {}),
  };
}

function parseProduct(row: CsvRow): ProductInput {
  if (!productIdField.safeParse(row.product_id).success) throw new OperationError("product_id must be a stable lowercase ID.");
  return {
    id: row.product_id, slug: row.slug, name: row.name, departmentId: row.category_id, description: row.description,
    specifications: json(row.attributes_json, "attributes_json"), images: json(row.gallery_json, "gallery_json"),
    keywords: row.keywords.split("|").map((part) => part.trim()).filter(Boolean),
    collectionIds: row.collection_ids.split("|").map((part) => part.trim()).filter(Boolean),
    publication: row.publication as ProductInput["publication"], demo: bool(row.demo, "demo"),
    featured: bool(row.featured, "featured"), newArrival: bool(row.new_arrival, "new_arrival"), variants: [],
  };
}

export function parseCatalog(csv: string, reviewConflicts = false) {
  const issues: Issue[] = [];
  const groups = new Map<string, Group>();
  let records: Entry[];
  try {
    records = parse(csv, { bom: true, trim: true, skip_empty_lines: true, relax_column_count: true, info: true, max_record_size: 24_000 }) as unknown as Entry[];
  } catch (error) {
    const line = error && typeof error === "object" && "lines" in error && typeof error.lines === "number" ? error.lines : 1;
    return { groups, issues: [{ row: line, message: "Malformed CSV. Check separators and escaped quotation marks." }] };
  }
  const header = records.shift()?.record ?? [];
  if (header.length !== columns.length || new Set(header).size !== columns.length || columns.some((column) => !header.includes(column))) {
    return { groups, issues: [{ row: 1, message: "Use the column names in the template. There are no inventory columns." }] };
  }
  if (!records.length || records.length > 150) {
    return { groups, issues: [{ row: 1, message: "Provide 1 to 150 variant rows per file." }] };
  }
  const skus = new Map<string, number>();
  const skuInputs = new Map<string, { productId: string; row: CsvRow }>();
  const slugs = new Map<string, string>();
  for (const { record, info } of records) {
    const line = info.lines;
    try {
      if (record.length !== columns.length) throw new OperationError("This row has the wrong number of columns.");
      const row = Object.fromEntries(header.map((name, index) => [name, record[index]])) as CsvRow;
      const product = parseProduct(row);
      const variant = parseVariant(row);
      const sku = variant.sku.toUpperCase();
      const priorSku = skuInputs.get(sku);
      const current = groups.get(product.id);
      if (reviewConflicts && current && priorSku?.productId === product.id) {
        const changes = columns.filter((field) => row[field] !== priorSku.row[field]);
        if (!changes.length) current.duplicates.push(line);
        else current.conflicts.push(...changes.map((field) => ({ row: line, field, earlier: priorSku.row[field].slice(0, 500), incoming: row[field].slice(0, 500) })));
        continue;
      }
      if (skus.has(sku)) throw new OperationError(`SKU ${sku} also appears on row ${skus.get(sku)}.`);
      const owner = slugs.get(product.slug);
      if (owner && owner !== product.id) throw new OperationError(`The slug is also used by product ${owner} in this file.`);
      const productKey = JSON.stringify(productColumns.map((name) => row[name]));
      const group = current ?? { product, rows: [], productKey, conflicts: [], duplicates: [] };
      if (group.productKey !== productKey) {
        if (!reviewConflicts) throw new OperationError("Product fields must match on every row for this product ID.");
        const values = JSON.parse(group.productKey) as string[];
        group.conflicts.push(...productColumns.flatMap((field, index) => values[index] === row[field] ? [] :
          [{ row: line, field, earlier: values[index].slice(0, 500), incoming: row[field].slice(0, 500) }]));
      }
      group.product.variants.push(variant);
      group.rows.push(line);
      groups.set(product.id, group);
      skus.set(sku, line);
      if (reviewConflicts) skuInputs.set(sku, { productId: product.id, row });
      slugs.set(product.slug, product.id);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      issues.push({ row: line, message: error.message });
    }
  }
  return { groups, issues };
}

async function prepareImport(actorId: string, csv: string) {
  await authorize(getDb(), actorId, true);
  const { groups, issues } = parseCatalog(csv);
  const prepared: { entry: ImportEntry; product: ProductInput; revision: number | null }[] = [];
  for (const { product, rows } of groups.values()) {
    try {
      const result = await previewProduct(actorId, product);
      const skus = product.variants.map(({ sku }) => sku);
      prepared.push({ entry: { id: product.id, name: product.name, rows, skus, status: result.status }, product, revision: result.revision });
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      issues.push(...rows.map((row) => ({ row, message: error.message })));
    }
  }
  issues.sort((a, b) => a.row - b.row);
  const file = createHash("sha256").update(csv).digest("hex");
  const token = quoteDigest(JSON.stringify({
    scope: "catalog.import", actorId, file, revisions: prepared.map(({ entry, revision }) => [entry.id, revision]),
  }));
  return { prepared, issues, token };
}

export async function previewImport(actorId: string, csv: string): Promise<ImportPreview> {
  const { prepared, issues, token } = await prepareImport(actorId, csv);
  return { issues, entries: prepared.map(({ entry }) => entry), ...(issues.length === 0 && prepared.length ? { token } : {}) };
}

export async function applyImport(actorId: string, csv: string, token: string): Promise<ImportResult[]> {
  const { prepared, issues, token: expected } = await prepareImport(actorId, csv);
  if (issues.length || !prepared.length || !equalDigest(token, expected)) {
    throw new OperationError("The file or catalog changed. Review a fresh preview before applying the import.");
  }
  const results: ImportResult[] = [];
  for (const { entry, product, revision } of prepared) {
    try {
      const status = await saveProduct(actorId, product, revision, "csv");
      results.push({ id: entry.id, status });
    } catch (error) {
      const message = error instanceof OperationError ? error.message : "The database could not save this product.";
      if (!(error instanceof OperationError)) reportFailure("staff.catalog-import", undefined, error);
      results.push({ id: entry.id, status: "Failed", message });
    }
  }
  return results;
}
