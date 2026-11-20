import { createHash } from "node:crypto";
import type { MarketId } from "../../config/markets.ts";
import { csvRows, exchangeCsv, exchangeToken, requireExchangeConfirmation,
  type ExchangeResult } from "../catalog/csv-exchange.ts";
import { ListingReviewError, saveSellerListing, validateSellerListingDraft, type SellerListingDraft } from "./listing-review.ts";

const columns = ["listing_key", "name", "category_id", "description", "sku", "variant_label", "options_json", "price_minor"] as const;
export const sellerListingTemplate = exchangeCsv(columns);

function requestId(key: string) {
  const digest = createHash("sha256").update("seller-listing-import\0").update(key).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function optionsJson(value: string) {
  try { return JSON.parse(value || "{}"); }
  catch { throw new ListingReviewError('Options must be a JSON object such as {"Color":"Blue"}.'); }
}

export async function importSellerListings(shopperId: string, marketId: MarketId, csv: string, token?: string) {
  const { rows, issues } = csvRows(csv, columns);
  const groups = new Map<string, typeof rows>();
  const skus = new Set<string>();
  for (const row of rows) {
    const { listing_key: key } = row.fields;
    const sku = row.fields.sku.toUpperCase();
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) {
      issues.push({ row: row.line, message: "Use a lowercase listing key with letters, digits or hyphens." });
      continue;
    }
    if (skus.has(sku)) {
      issues.push({ row: row.line, message: "Each SKU can only appear once in the file." });
      continue;
    }
    skus.add(sku);
    const entries = groups.get(key) ?? [];
    entries.push(row);
    groups.set(key, entries);
  }
  const prepared: { key: string; rows: number[]; draft: SellerListingDraft }[] = [];
  for (const [key, entries] of groups) {
    const first = entries[0].fields;
    try {
      if (entries.some(entry => (["name", "category_id", "description"] as const).some(field => entry.fields[field] !== first[field]))) {
        throw new ListingReviewError("Keep the name, category and description identical on each row for a listing key.");
      }
      const draft = await validateSellerListingDraft(shopperId, marketId, {
        name: first.name, departmentId: first.category_id, description: first.description,
        variants: entries.map(({ fields }, index) => {
          if (fields.price_minor && !/^\d{1,8}$/.test(fields.price_minor)) {
            throw new ListingReviewError("Enter price_minor as an integer in the selected market’s minor units.");
          }
          return { sku: fields.sku, label: fields.variant_label || "Standard", options: optionsJson(fields.options_json),
            amountMinor: fields.price_minor ? Number(fields.price_minor) : null, isDefault: index === 0 };
        }),
      }, requestId(key));
      prepared.push({ key, rows: entries.map(row => row.line), draft });
    } catch (error) {
      if (!(error instanceof ListingReviewError) || error.status === 403) throw error;
      issues.push(...entries.map(row => ({ row: row.line, message: error.message })));
    }
  }
  issues.sort((a, b) => a.row - b.row);
  const confirmation = exchangeToken(shopperId, `seller:${marketId}`, csv);
  if (token === undefined) return { issues, entries: prepared.map(({ key, rows, draft }) => ({ key, rows, name: draft.name })),
    ...(!issues.length && { token: confirmation }) };
  requireExchangeConfirmation(token, confirmation, issues);
  const results: (Omit<ExchangeResult, "status"> & { status: "Saved" | "Failed"; productId?: string })[] = [];
  for (const { key, rows, draft } of prepared) {
    try {
      const saved = await saveSellerListing(shopperId, { action: "save", marketId, operationId: requestId(key), draft });
      results.push({ key, rows, status: "Saved", productId: saved.productId });
    } catch (error) {
      results.push({ key, rows, status: "Failed", message: error instanceof ListingReviewError ? error.message : "This draft could not be saved." });
    }
  }
  return { results };
}
