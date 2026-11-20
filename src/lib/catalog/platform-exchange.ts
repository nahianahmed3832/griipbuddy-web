import { createHash } from "node:crypto";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { storeShop } from "../marketplace/constants.ts";
import { skuField, textField } from "../staff/catalog-input.ts";
import { CatalogWriteError, OperationError, catalogWriteInput } from "../staff/operation-error.ts";
import { authorize } from "../staff/operations.ts";
import { productFoundationInput } from "../staff/product-foundation-input.ts";
import { saveWorkspaceProduct } from "../staff/product-publication.ts";
import { categoryInput, saveCategory } from "../staff/taxonomy.ts";
import { csvRows, exchangeCsv, exchangeLimit, exchangeToken, requireExchangeConfirmation,
  type ExchangeEntry, type ExchangeIssue, type ExchangeResult } from "./csv-exchange.ts";
import { scopedCatalogPilotRequested } from "./main-admin-config.ts";

export const exchangeKind = z.enum(["products", "categories"]);
const exportMode = z.enum(["template", "export"]);
export const exchangeRead = z.strictObject({ read: z.literal("catalog-exchange"), kind: exchangeKind,
  mode: exportMode, page: z.int().min(1).max(10000).optional() });
const exchangeInput = z.strictObject({ kind: exchangeKind, csv: z.string().min(1).max(exchangeLimit),
  token: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const productColumns = ["product_id", "slug", "name", "category_id", "description", "sku", "options_json", "gtin"] as const;
const categoryColumns = ["category_id", "slug", "name", "short_name", "description", "kind", "parent_id", "position", "state", "image_path", "image_alt"] as const;
const shopScope = { OR: [{ marketplaceShopId: null }, { marketplaceShopId: storeShop.id }] };
const optionsField = z.record(textField(1, 40), textField(1, 70));
const exportSize = 20;

type Category = z.output<typeof categoryInput>;
type Product = z.output<typeof productFoundationInput>;
type Prepared = { entry: ExchangeEntry; data: Category | Product };
type Plan = { prepared: Prepared[]; issues: ExchangeIssue[] };

function rowMessage(error: unknown) {
  return error instanceof OperationError ? error.message : "This row could not be saved. Refresh the catalog and preview again.";
}

function stableId(prefix: string, ...parts: string[]) {
  return prefix + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 30);
}

async function authority(actorId: string) {
  await authorize(getDb(), actorId, true);
  if (scopedCatalogPilotRequested()) throw new CatalogWriteError("forbidden", "Bulk changes are unavailable for the fenced catalog pilot.");
}

async function categoryPlan(csv: string): Promise<Plan> {
  const { rows, issues } = csvRows(csv, categoryColumns);
  const prepared: Prepared[] = [];
  const candidates = new Map<string, { row: number; data: Category }>();
  const slugs = new Set<string>();
  for (const { line, fields } of rows) {
    try {
      const data = catalogWriteInput(categoryInput, { id: fields.category_id, slug: fields.slug, name: fields.name,
        shortName: fields.short_name, description: fields.description, kind: fields.kind, parentId: fields.parent_id || null,
        position: /^\d{1,4}$/.test(fields.position) ? Number(fields.position) : null, state: fields.state,
        image: { src: fields.image_path, alt: fields.image_alt }, revision: null });
      if (candidates.has(data.id) || slugs.has(data.slug)) throw new OperationError("Duplicate category ID or slug in this file.");
      candidates.set(data.id, { row: line, data });
      slugs.add(data.slug);
    } catch (error) { issues.push({ row: line, message: rowMessage(error) }); }
  }
  const db = getDb();
  const needed = [...candidates.values()].flatMap(({ data }) => data.parentId ? [data.id, data.parentId] : [data.id]);
  const existing = await db.department.findMany({ where: { OR: [{ id: { in: needed } }, { slug: { in: [...slugs] } }] },
    select: { id: true, slug: true, kind: true, state: true } });
  const byId = new Map(existing.map(row => [row.id, row]));
  const bySlug = new Map(existing.map(row => [row.slug, row.id]));
  const levels = { DEPARTMENT: 0, CATEGORY: 1, SUBCATEGORY: 2 };
  for (const { row, data } of [...candidates.values()].sort((a, b) => levels[a.data.kind] - levels[b.data.kind])) {
    const saved = byId.get(data.id);
    const slugOwner = bySlug.get(data.slug);
    const parent = data.parentId && (byId.get(data.parentId) ?? candidates.get(data.parentId)?.data);
    if ((saved && saved.slug !== data.slug) || (slugOwner && slugOwner !== data.id)) {
      issues.push({ row, message: "This category ID or slug already belongs to another record." });
      continue;
    }
    if (!saved && (data.kind === "DEPARTMENT" ? data.parentId !== null : !parent || !parent.kind ||
      levels[parent.kind] !== levels[data.kind] - 1 || data.state === "ACTIVE" && parent.state !== "ACTIVE")) {
      issues.push({ row, message: "Choose a parent at the required category level. An active category needs an active parent." });
      continue;
    }
    prepared.push({ entry: { key: data.id, name: data.name, rows: [row], status: saved ? "Unchanged" : "New" }, data });
  }
  return { prepared, issues };
}

function productOptions(value: string) {
  try { return catalogWriteInput(optionsField, JSON.parse(value || "{}")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new OperationError("Options must be a JSON object such as {\"Color\":\"Blue\"}.");
    throw error;
  }
}

async function productPlan(csv: string): Promise<Plan> {
  const { rows, issues } = csvRows(csv, productColumns);
  const groups = new Map<string, typeof rows>();
  const seenSkus = new Set<string>();
  for (const row of rows) {
    const sku = skuField.safeParse(row.fields.sku);
    if (!sku.success || seenSkus.has(sku.data)) {
      issues.push({ row: row.line, message: "Enter a valid SKU that only appears once in this file." });
      continue;
    }
    seenSkus.add(sku.data);
    const entries = groups.get(row.fields.product_id) ?? [];
    entries.push(row);
    groups.set(row.fields.product_id, entries);
  }
  const db = getDb();
  const ids = [...groups.keys()];
  const [existing, categories, variants] = await Promise.all([
    db.product.findMany({ where: { OR: [{ id: { in: ids } }, { slug: { in: rows.map(row => row.fields.slug) } }] },
      select: { id: true, slug: true, foundation: true, marketplaceShopId: true } }),
    db.department.findMany({ where: { id: { in: rows.map(row => row.fields.category_id) }, state: "ACTIVE", kind: { not: null } }, select: { id: true } }),
    db.variant.findMany({ where: { sku: { in: [...seenSkus], mode: "insensitive" } }, select: { productId: true, sku: true } }),
  ]);
  const byId = new Map(existing.map(row => [row.id, row]));
  const bySlug = new Map(existing.map(row => [row.slug, row.id]));
  const active = new Set(categories.map(row => row.id));
  const existingSkus = new Map(variants.map(row => [row.sku.toUpperCase(), row.productId]));
  const prepared: Prepared[] = [];
  for (const [productId, entries] of groups) {
    const [first] = entries;
    const fields = first.fields;
    try {
      const saved = byId.get(productId);
      if (saved && (!saved.foundation || (saved.marketplaceShopId !== null && saved.marketplaceShopId !== storeShop.id))) {
        throw new OperationError("This product identifier is outside the platform catalog exchange scope.");
      }
      if (saved && saved.slug !== fields.slug || bySlug.has(fields.slug) && bySlug.get(fields.slug) !== productId) {
        throw new OperationError("This product ID and URL slug do not identify the same catalog entry.");
      }
      if (entries.some(entry => (["slug", "name", "category_id", "description"] as const).some(key => entry.fields[key] !== fields[key]))) {
        throw new OperationError("Keep shared product fields identical on every row for this product ID.");
      }
      if (!active.has(fields.category_id)) throw new OperationError("Choose the ID of an active product category.");
      const picks = entries.map(entry => productOptions(entry.fields.options_json));
      const options = Object.keys(picks[0]).sort().map(key => ({ id: stableId("option-", productId, key), label: key, key,
        values: [...new Set(picks.flatMap(pick => pick[key] === undefined ? [] : [pick[key]]))].map(value =>
          ({ id: stableId("value-", productId, key, value), label: value, value })) }));
      const desired = entries.map(({ fields: row }, index) => ({
        id: stableId("v-", productId, row.sku.toUpperCase()), sku: row.sku, gtin: row.gtin || null, active: true,
        selections: Object.fromEntries(Object.keys(picks[index]).map(key => [stableId("option-", productId, key), stableId("value-", productId, key, picks[index][key])])),
      }));
      if (desired.some(variant => existingSkus.has(variant.sku.toUpperCase()) && existingSkus.get(variant.sku.toUpperCase()) !== productId)) {
        throw new OperationError("A SKU in this group is already assigned to another product.");
      }
      const data = catalogWriteInput(productFoundationInput, { id: productId, slug: fields.slug, expectedRevision: null,
        primaryCategoryId: fields.category_id, name: fields.name, description: fields.description, publication: "DRAFT",
        options, variants: desired, defaultVariantId: desired[0].id });
      bySlug.set(fields.slug, productId);
      prepared.push({ entry: { key: productId, rows: entries.map(row => row.line), name: fields.name, status: saved ? "Unchanged" : "New" }, data });
    } catch (error) { issues.push(...entries.map(row => ({ row: row.line, message: rowMessage(error) }))); }
  }
  return { prepared, issues };
}

export async function runPlatformExchange(actorId: string, marketId: MarketId, action: "preview" | "apply", raw: unknown) {
  await authority(actorId);
  const { csv, kind, token } = catalogWriteInput(exchangeInput, raw);
  const { prepared, issues } = await (kind === "categories" ? categoryPlan(csv) : productPlan(csv));
  issues.sort((a, b) => a.row - b.row);
  const confirmation = exchangeToken(actorId, `${marketId}:${kind}`, csv);
  if (action === "preview") return { issues, entries: prepared.map(row => row.entry), ...(!issues.length && { token: confirmation }) };
  requireExchangeConfirmation(token ?? "", confirmation, issues);
  const results: ExchangeResult[] = [];
  for (const { entry, data } of prepared) {
    const result = { key: entry.key, rows: entry.rows };
    if (entry.status === "Unchanged") {
      results.push({ ...result, status: "Unchanged" });
      continue;
    }
    try {
      if ("parentId" in data) await saveCategory(actorId, data);
      else await saveWorkspaceProduct(actorId, data);
      results.push({ ...result, status: "Created" });
    } catch (error) { results.push({ ...result, status: "Failed", message: rowMessage(error) }); }
  }
  return { results };
}

export async function readPlatformExchange(actorId: string, request: z.output<typeof exchangeRead>) {
  await authority(actorId);
  const category = request.kind === "categories";
  const columns = category ? categoryColumns : productColumns;
  if (request.mode === "template") return { csv: exchangeCsv(columns), hasNext: false };
  const db = getDb();
  const skip = ((request.page ?? 1) - 1) * exportSize;
  if (category) {
    const records = await db.department.findMany({ where: { kind: { not: null }, state: { not: "ARCHIVED" } },
      orderBy: [{ kind: "asc" }, { position: "asc" }, { id: "asc" }], skip, take: exportSize + 1 });
    const rows = records.slice(0, exportSize).map(row => [row.id, row.slug, row.name, row.shortName, row.description,
      row.kind, row.parentId, row.position, row.state, row.imageSrc, row.imageAlt]);
    return { csv: exchangeCsv(columns, rows), hasNext: records.length > exportSize };
  }
  const variants = await db.variant.findMany({ where: { active: true, archivedAt: null, product: { foundation: true, ...shopScope } },
    orderBy: [{ productId: "asc" }, { position: "asc" }, { id: "asc" }], skip, take: exportSize + 1,
    select: { sku: true, gtin: true, options: true, product: { select: { id: true, slug: true, name: true, departmentId: true, description: true } } } });
  const rows = variants.slice(0, exportSize).map(({ product, sku, options, gtin }) => [product.id, product.slug, product.name,
    product.departmentId, product.description, sku, JSON.stringify(options), gtin]);
  return { csv: exchangeCsv(columns, rows), hasNext: variants.length > exportSize };
}
