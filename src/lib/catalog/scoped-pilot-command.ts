import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { nativeSourceSystem } from "../catalog-migration/contracts.ts";
import { getDb } from "../db/client.ts";
import { storeShop } from "../marketplace/constants.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";
import { scopedCatalogPilotDigest } from "./main-admin-config.ts";
import { scopedCatalogPilotTargets } from "./scoped-pilot.ts";

export async function requireScopedPilotCommand(marketId: MarketId, action: string, input: Record<string, unknown>) {
  const db = getDb();
  const digest = scopedCatalogPilotDigest();
  const approved = await scopedCatalogPilotTargets(db);
  if (!digest || !approved) throw new CatalogWriteError("unavailable", "The reviewed catalog pilot is unavailable.");
  const runId = digest;
  const { categoryIds, productIds, variantIds } = approved;
  const matches = (value: unknown, allowed: string[]) => typeof value === "string" && allowed.includes(value);
  const category = (value: unknown) => matches(value, categoryIds);
  const product = (value: unknown) => matches(value, productIds);
  const variant = (value: unknown) => matches(value, variantIds);
  const parent = (value: unknown) => value === null || category(value);
  const categoryList = (value: unknown) => Array.isArray(value) && value.every(category);
  const placements = () => category(input.primaryCategoryId) &&
    (input.secondaryCategoryIds === undefined || categoryList(input.secondaryCategoryIds));
  const rowIds = (rows: unknown, matches: (value: unknown) => boolean) => Array.isArray(rows) && rows.length > 0 &&
    rows.every(row => row && typeof row === "object" && matches((row as Record<string, unknown>).id));

  async function approvedPools(productId: unknown, values: unknown[]) {
    const parsed = z.array(z.uuid()).min(1).safeParse(values);
    if (typeof productId !== "string" || !product(productId) || !parsed.success || new Set(parsed.data).size !== parsed.data.length) return false;
    const mappings = await db.catalogMigrationMapping.findMany({ where: {
      runId, sourceSystem: nativeSourceSystem, OR: [{ entity: "stock", targetId: { in: parsed.data } }, { entity: "warehouse" }],
    }, select: { entity: true, targetId: true } });
    const poolIds = mappings.filter(row => row.entity === "stock").map(row => row.targetId);
    if (!parsed.data.every(id => poolIds.includes(id))) return false;
    const count = await db.inventoryPool.count({ where: {
      id: { in: parsed.data }, ownerId: storeShop.id, locationId: { in: mappings.filter(row => row.entity === "warehouse").map(row => row.targetId) },
      variantId: { in: variantIds }, variant: { productId },
    } });
    return count === parsed.data.length;
  }

  let allowed = false;
  if (marketId === "bd") {
    switch (action) {
      case "category.save":
        allowed = input.revision != null && category(input.id) && parent(input.parentId);
        break;
      case "category.move":
        allowed = category(input.id) && parent(input.parentId);
        break;
      case "category.reorder":
        allowed = category(input.parentId) && rowIds(input.siblings, category);
        break;
      case "category.archive":
      case "category.translation":
      case "category.presentation":
        allowed = category(input.id);
        break;
      case "category.attribute":
        allowed = category(input.departmentId);
        break;
      case "product.save":
        allowed = input.expectedRevision != null && product(input.id) && placements() &&
          rowIds(input.variants, variant) && (input.defaultVariantId == null || variant(input.defaultVariantId));
        break;
      case "product.assignments":
        allowed = product(input.productId) && placements();
        break;
      case "product.publish":
      case "product.translation":
        allowed = product(input.productId);
        break;
      case "product.gallery":
        allowed = product(input.productId) && (input.variantId === undefined || variant(input.variantId));
        break;
      case "variant.compatibility":
        allowed = product(input.productId) && variant(input.variantId);
        break;
      case "offer.save":
      case "offer.configure": {
        if (typeof input.variantId !== "string" || !variant(input.variantId) || input.sellerId !== storeShop.id) break;
        const offer = await db.marketOffer.findUnique({ where: { variantId_marketId: { variantId: input.variantId, marketId } },
          select: { offerId: true } });
        allowed = Boolean(offer?.offerId && await db.catalogMigrationMapping.findFirst({ where: {
          runId, sourceSystem: nativeSourceSystem, entity: "offer", targetId: offer.offerId,
        }, select: { targetId: true } }));
        break;
      }
      case "inventory.movement":
        allowed = await approvedPools(input.productId, [input.poolId]);
        break;
      case "inventory.transfer":
        allowed = await approvedPools(input.productId, [input.fromPoolId, input.toPoolId]);
        break;
    }
  }
  if (!allowed) throw new CatalogWriteError("forbidden", "This command is outside the reviewed Bangladesh catalog pilot.");
}
