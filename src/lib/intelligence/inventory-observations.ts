import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { dispatchStockRelations, legacyLocationId, stockLocations } from "../commerce/location-inventory.ts";
import { marketHasDelivery } from "../commerce/orders.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { productionDatabase, requireOperatingDatabase } from "../db/local.ts";
import { marketConfiguration } from "../market-config.ts";
import { merchantProductEligibility } from "../marketplace/market-grants.ts";
import type { IntelligenceInput, InventoryIntelligence } from "./types.ts";

const hour = 3_600_000;
const stockSelect = {
  id: true, label: true, productId: true, active: true, ...dispatchStockRelations,
  product: { select: { id: true, slug: true, name: true, departmentId: true, marketplaceShopId: true } },
} satisfies Prisma.VariantSelect;

export function catalogVariants(db: DbReader, input: IntelligenceInput, historic: string[], take: number) {
  const { marketId, test, productId, variantId } = input;
  return db.variant.findMany({
    where: { managedInventory: false, ...(productId && { productId }), ...(variantId && { id: variantId }),
      OR: [
        { active: true, offers: { some: { marketId, eligible: true, currency: marketConfiguration(marketId).currency, offerId: null } },
          product: { ...merchantProductEligibility(marketId), active: true, publication: "ACTIVE", ...(!test && { demo: false }) } },
        { id: { in: historic }, ...(!test && { product: { demo: false } }) },
      ] },
    select: { ...stockSelect, offers: { where: { marketId, eligible: true, currency: marketConfiguration(marketId).currency, offerId: null },
      select: { amountMinor: true, discountMinor: true, discountStartsAt: true, discountEndsAt: true } },
      product: { select: { ...stockSelect.product.select, active: true, publication: true, demo: true,
        marketplaceShop: { select: { published: true, marketGrants: { select: { marketId: true, status: true } } } } } } },
    orderBy: { id: "asc" }, take,
  });
}

export type IntelligenceVariant = Awaited<ReturnType<typeof catalogVariants>>[number];

export function variantOffer(row: Pick<IntelligenceVariant, "offers">, at: Date) {
  const offer = row.offers[0];
  if (!offer || !Number.isSafeInteger(offer.amountMinor) || offer.amountMinor < 0) return null;
  const discount = activeDiscount(offer, at);
  return { price: offer.amountMinor, discount: discount >= 0 && discount <= offer.amountMinor ? discount : 0 };
}

export function variantInventory(row: Pick<IntelligenceVariant, "id" | "inventory" | "locationInventory"> & {
  product: { marketplaceShopId: string | null };
}, marketId: MarketId): InventoryIntelligence {
  const unknown: InventoryIntelligence = { available: null, reserved: null, incoming: null, poolIds: [], kind: "unknown" };
  if (marketConfiguration(marketId).checkoutAuthority !== "native") return unknown;
  const locations = stockLocations(row, marketId, row.product.marketplaceShopId);
  if (!locations.length || locations.some(location => location.available < 0) ||
      (locations[0].locationId === legacyLocationId && !row.inventory)) return unknown;
  return { available: locations.reduce((sum, location) => sum + location.available, 0), reserved: null, incoming: null,
    poolIds: locations.map(location => `${location.locationId}:${row.id}`),
    kind: locations[0].locationId === legacyLocationId ? "shared" : "market" };
}

export async function observeProductIntelligence(marketId: MarketId) {
  requireOperatingDatabase();
  const db = getDb();
  const market = marketConfiguration(marketId);
  if (market.status !== "staging" && market.status !== "active") throw new Error("Observe only an operating market.");
  const test = !productionDatabase();
  const observedAt = new Date();
  const slot = new Date(Math.floor(+observedAt / hour) * hour);
  const deliveryAvailable = await marketHasDelivery(marketId).catch(() => null);
  let count = 0;
  let cursor: string | undefined;
  const take = 1_000;
  for (;;) {
    const page = await db.variant.findMany({
      where: { ...(cursor && { id: { gt: cursor } }), active: true, managedInventory: false,
        offers: { some: { marketId, eligible: true, currency: market.currency, offerId: null } },
        product: { ...merchantProductEligibility(marketId), active: true, publication: "ACTIVE", ...(!test && { demo: false }) } },
      select: { ...stockSelect, offers: { where: { marketId, eligible: true, currency: market.currency, offerId: null },
        select: { amountMinor: true, discountMinor: true, discountStartsAt: true, discountEndsAt: true } } },
      orderBy: { id: "asc" }, take,
    });
    if (!page.length) break;
    const rows = page.flatMap(variant => {
      const price = variantOffer(variant, observedAt);
      if (!price) return [];
      return [{ marketId, test, variantId: variant.id, slot, observedAt, currency: market.currency,
        priceMinor: price.price, discountMinor: price.discount, available: variantInventory(variant, marketId).available,
        deliveryAvailable, source: "market-offer-and-inventory" }];
    });
    if (rows.length) count += (await db.productIntelligenceSnapshot.createMany({ data: rows, skipDuplicates: true })).count;
    if (page.length < take) break;
    cursor = page.at(-1)?.id;
  }
  return { marketId, currency: market.currency, test, observedAt, count };
}
