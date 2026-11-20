import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { csvRows, exchangeCsv, exchangeToken, requireExchangeConfirmation } from "../catalog/csv-exchange.ts";
import { getDb } from "../db/client.ts";
import { productIdField } from "../staff/catalog-input.ts";
import { CatalogWriteError, OperationError } from "../staff/operation-error.ts";
import { runWorkspaceStockCommand } from "../staff/product-workspace-commerce.ts";
import { sellerStockAccess } from "./seller-stock.ts";

const headers = ["pool_id", "product_id", "operation_key", "units", "reason", "reference", "expected_updated_at"] as const;
export const sellerStockTemplate = exchangeCsv(headers);
const rowInput = z.strictObject({ poolId: z.uuid(), productId: productIdField, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:/-]{1,120}$/),
  quantity: z.int().min(-1_000_000).max(1_000_000).refine(value => value !== 0, "Enter a nonzero whole quantity."),
  reason: z.string().trim().min(1).max(240), reference: z.string().trim().min(1).max(160), expectedUpdatedAt: z.iso.datetime() });

export async function importSellerStock(shopperId: string, marketId: MarketId, csv: string, token?: string) {
  const { rows, issues } = csvRows(csv, headers);
  const db = getDb();
  const { shop, location, owner } = await sellerStockAccess(db, shopperId, marketId);
  if (!owner) throw new CatalogWriteError("forbidden", "Stock import is available to the shop owner.");
  const candidates = new Map<string, { row: number; input: z.output<typeof rowInput> }>();
  for (const { line, fields } of rows) {
    const parsed = rowInput.safeParse({ poolId: fields.pool_id, productId: fields.product_id, idempotencyKey: fields.operation_key,
      quantity: /^-?\d{1,7}$/.test(fields.units) ? Number(fields.units) : null, reason: fields.reason, reference: fields.reference,
      expectedUpdatedAt: fields.expected_updated_at });
    if (!parsed.success) { issues.push({ row: line, message: "Use a pool ID, product ID, operation key, signed unit count, reason, reference and exact exported timestamp." }); continue; }
    if (candidates.has(parsed.data.poolId)) { issues.push({ row: line, message: "Use one adjustment per pool in each file." }); continue; }
    candidates.set(parsed.data.poolId, { row: line, input: parsed.data });
  }
  const pools = await db.inventoryPool.findMany({ where: { id: { in: [...candidates.keys()] }, ownerId: shop.id,
    location: { AND: [location, { active: true }] }, variant: { active: true, archivedAt: null, managedInventory: true } },
    select: { id: true, onHand: true, reserved: true, updatedAt: true, variant: { select: { productId: true, sku: true } } } });
  const byId = new Map(pools.map(pool => [pool.id, pool]));
  const receipts = await db.inventoryMovement.findMany({ where: {
    OR: pools.flatMap(pool => {
      const entry = candidates.get(pool.id);
      return entry ? [{ poolId: pool.id, idempotencyKey: entry.input.idempotencyKey }] : [];
    }),
  }, select: { id: true, poolId: true, quantity: true, reason: true, reference: true, kind: true, actorId: true } });
  const byPool = new Map(receipts.map(receipt => [receipt.poolId, receipt]));
  const entries = [];
  for (const [poolId, { row, input }] of candidates) {
    const pool = byId.get(poolId);
    if (!pool || pool.variant.productId !== input.productId) {
      issues.push({ row, message: "The stock pool is outside the selected shop, product or market." });
      continue;
    }
    const receipt = byPool.get(poolId);
    if (receipt) {
      if (receipt.kind !== "ADJUSTMENT" || receipt.quantity !== input.quantity || receipt.reason !== input.reason ||
          receipt.reference !== input.reference || receipt.actorId !== shopperId) {
        issues.push({ row, message: "The operation key was used with different movement facts." });
        continue;
      }
    } else if (+pool.updatedAt !== Date.parse(input.expectedUpdatedAt) || pool.onHand + input.quantity < pool.reserved) {
      issues.push({ row, message: "The pool changed or this adjustment would consume reserved units. Export a fresh view." });
      continue;
    }
    entries.push({ row, sku: pool.variant.sku, input, replay: Boolean(receipt) });
  }
  issues.sort((a, b) => a.row - b.row);
  const confirmation = exchangeToken(shopperId, `inventory:${marketId}`, csv);
  if (token === undefined) return { issues, entries: entries.map(({ row, sku, input, replay }) => ({ row, sku, units: input.quantity, replay })),
    ...(!issues.length && { token: confirmation }) };
  requireExchangeConfirmation(token, confirmation, issues);
  const results: { row: number; status: string; message?: string }[] = [];
  for (const { row, input, replay } of entries) {
    try {
      await runWorkspaceStockCommand({ kind: "seller", id: shopperId }, "inventory.movement", { ...input, marketId, kind: "ADJUSTMENT" });
      results.push({ row, status: replay ? "Already posted" : "Posted" });
    } catch (error) {
      results.push({ row, status: "Failed", message: error instanceof OperationError ? error.message : "The movement did not post. Review the latest balances." });
    }
  }
  return { results };
}
