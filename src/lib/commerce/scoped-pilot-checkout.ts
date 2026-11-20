import type { MarketId } from "../../config/markets.ts";
import { nativeSourceSystem } from "../catalog-migration/contracts.ts";
import { recoveredCategorySource } from "../catalog/category-reference.ts";
import { scopedCatalogPilotDigest, scopedCatalogPilotRequested } from "../catalog/main-admin-config.ts";
import { scopedCatalogPilotTargets } from "../catalog/scoped-pilot.ts";
import { resolveCartVariantReferences } from "../cart/legacy-reference.ts";
import type { DbReader } from "../db/client.ts";
import { marketConfiguration, type MarketPaymentMethod } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import type { QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";

type CheckoutReference = { variantId: string; offerId?: string; cartVariantId?: string };
type CheckoutScope = { marketId: MarketId; paymentMethod: MarketPaymentMethod | "recovered"; items: readonly CheckoutReference[] };

function blocked(message: string): never {
  throw new CommerceError({ kind: "unavailable", message });
}

export async function reviewedCheckoutVariants(db: DbReader, items: readonly CheckoutReference[]) {
  if (!scopedCatalogPilotRequested()) return new Set<string>();
  const ids = [...new Set(items.flatMap(item => [item.variantId, ...(item.cartVariantId ? [item.cartVariantId] : [])]))];
  if (!ids.length) return new Set<string>();
  const aliases = await resolveCartVariantReferences(ids, db);
  const candidates = [...new Set([...ids, ...aliases.values()])];
  const variants = await db.variant.findMany({ where: { id: { in: candidates } }, select: { id: true, productId: true } });
  const recoveredIds = ids.filter(id => /^v-[a-f0-9]{24}$/.test(id)).map(id => id.slice(2));
  const rows = await db.catalogMigrationMapping.findMany({ where: {
    sourceSystem: recoveredCategorySource, OR: [
      { entity: "variant", OR: [{ targetId: { in: candidates } }, { sourceId: { in: recoveredIds } }] },
      { entity: "product", targetId: { in: variants.map(row => row.productId) } },
    ],
  }, select: { entity: true, sourceId: true, targetId: true } });
  const products = new Set(rows.filter(row => row.entity === "product").map(row => row.targetId));
  const reviewed = new Set(rows.filter(row => row.entity === "variant").flatMap(row => [row.targetId, `v-${row.sourceId}`]));
  for (const row of variants) if (products.has(row.productId)) reviewed.add(row.id);
  for (const [from, to] of aliases) if (reviewed.has(to)) reviewed.add(from);
  return reviewed;
}

export async function pilotCheckoutScope(db: DbReader, { marketId, paymentMethod, items }: CheckoutScope) {
  if (!(await reviewedCheckoutVariants(db, items)).size) return null;
  const runId = scopedCatalogPilotDigest();
  if (!runId) blocked("Checkout for reviewed catalog items is temporarily unavailable.");
  const approved = await scopedCatalogPilotTargets(db);
  if (!approved) blocked("Checkout for reviewed catalog items is temporarily unavailable.");
  if (marketId !== "bd" || paymentMethod !== "COD" || marketConfiguration(marketId).checkoutAuthority !== "native") {
    blocked("Reviewed catalog items use test cash on delivery in Bangladesh.");
  }
  const matches = items.filter(item => approved.variantIds.includes(item.variantId)).length;
  if (!matches) blocked("Review the exact offer for your reviewed catalog items in the cart.");
  if (matches !== items.length) blocked("Place reviewed catalog items and other products in separate orders.");
  const variantIds = [...new Set(items.map(item => item.variantId))];
  const mappings = await db.catalogMigrationMapping.findMany({ where: {
    runId, sourceSystem: nativeSourceSystem, entity: { in: ["offer", "stock", "warehouse"] },
  }, select: { entity: true, targetId: true } });
  const targetIds = (entity: string) => mappings.filter(row => row.entity === entity).map(row => row.targetId);
  const offers = await db.marketOffer.findMany({ where: {
    variantId: { in: variantIds }, marketId, offerId: { in: targetIds("offer") },
    identity: { sellerId: storeShop.id, retiredAt: null },
  }, select: { variantId: true, offerId: true } });
  const offersByVariant = new Map(offers.map(offer => [offer.variantId, offer.offerId]));
  if (items.some(item => !item.offerId || offersByVariant.get(item.variantId) !== item.offerId)) {
    blocked("Review the current offer for your reviewed catalog items in the cart.");
  }
  const pools = await db.inventoryPool.findMany({ where: {
    id: { in: targetIds("stock") }, variantId: { in: variantIds }, ownerId: storeShop.id,
    locationId: { in: targetIds("warehouse") },
  }, select: { id: true } });
  return { poolIds: pools.map(pool => pool.id) };
}

export function pilotQuoteScope(db: DbReader, marketId: MarketId, paymentMethod: MarketPaymentMethod, lines: readonly QuoteLine[]) {
  return pilotCheckoutScope(db, { marketId, paymentMethod, items: lines.map(line => ({
    variantId: line.variantId, offerId: line.offerIdSnapshot, cartVariantId: line.cartVariantIdSnapshot,
  })) });
}
