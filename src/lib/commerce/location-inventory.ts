import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { variantQuantities } from "../cart/model.ts";
import { storeShop } from "../marketplace/constants.ts";
import { marketVisibilitySelect, merchantProductEligible } from "../marketplace/market-grants.ts";
import { CommerceError } from "./errors.ts";
import { marketConfiguration } from "../market-config.ts";
import type { DbReader } from "../db/client.ts";

export const legacyLocationId = "legacy-primary";
const legacyLocationName = "Shared dispatch";

const locationSelect = { id: true, name: true, shopId: true, marketId: true, active: true, priority: true } as const;
export const dispatchStockRelations = {
  inventory: { select: { available: true } },
  locationInventory: { select: { available: true, location: { select: locationSelect } } },
} satisfies Prisma.VariantInclude;

type VariantStock = Pick<Prisma.VariantGetPayload<{ include: typeof dispatchStockRelations }>, "inventory" | "locationInventory">;
type CheckoutStockLine = { variantId: string; quantity: number; personalization?: string };
type StockMovement = { variantId: string; locationId: string; quantity: number };
type StockLocation = { locationId: string; locationName: string; available: number };
export type LocationReceiptLine = { id: string; variantId: string; quantity: number; receivedBefore?: number };

const allocationInput = z.object({
  variantId: z.string().min(1), quantity: z.int().positive(), personalization: z.string(),
  locationId: z.string().min(1), locationName: z.string().min(1),
});
export type StockAllocation = z.infer<typeof allocationInput>;

export class InventoryLocationError extends Error {}

export async function hasInventoryCommitment(db: DbReader, orderId: string) {
  return Boolean(await db.inventoryReservation.findUnique({ where: { orderId }, select: { id: true } }));
}

export function inventoryShopId(shopId?: string | null) {
  return shopId && shopId !== storeShop.id ? shopId : null;
}

function byId(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stockLocations(variant: VariantStock, marketId: MarketId, shopId: string | null): StockLocation[] {
  if (!variant.locationInventory.length) {
    return marketConfiguration(marketId).catalog.inventory === "shared-legacy" ? [{
      locationId: legacyLocationId, locationName: legacyLocationName, available: variant.inventory?.available ?? 0,
    }] : [];
  }
  return variant.locationInventory
    .filter(({ location }) => location.id !== legacyLocationId && location.active && location.marketId === marketId &&
      inventoryShopId(location.shopId) === inventoryShopId(shopId))
    .sort((a, b) => a.location.priority - b.location.priority || byId(a.location.id, b.location.id))
    .map(({ available, location }) => ({ locationId: location.id, locationName: location.name, available }));
}

export function marketStock(variant: VariantStock, marketId: MarketId, shopId: string | null) {
  return stockLocations(variant, marketId, shopId).reduce((sum, location) => sum + location.available, 0);
}

export async function lockVariantInventory(tx: Prisma.TransactionClient, variantIds: readonly string[]) {
  const sorted = [...new Set(variantIds)].sort(byId);
  if (!sorted.length) return;
  // The advisory locks also serialize first location assignment for variants without a legacy stock row.
  await tx.$queryRaw`
    SELECT 1 FROM (
      SELECT "variantId" FROM unnest(ARRAY[${Prisma.join(sorted)}]::text[]) AS stock("variantId")
      ORDER BY "variantId" COLLATE "C" OFFSET 0
    ) AS ordered
    CROSS JOIN LATERAL pg_advisory_xact_lock(hashtext(ordered."variantId"), 524)
  `;
  await tx.$queryRaw`
    SELECT "variantId" FROM "Inventory"
    WHERE "variantId" IN (${Prisma.join(sorted)}) ORDER BY "variantId" COLLATE "C" FOR UPDATE
  `;
}

export async function lockDispatchLocations(tx: Prisma.TransactionClient, variantIds: readonly string[]) {
  if (!variantIds.length) return;
  await tx.$queryRaw`
    SELECT "id" FROM "DispatchLocation"
    WHERE "id" IN (SELECT "locationId" FROM "LocationInventory" WHERE "variantId" IN (${Prisma.join(variantIds)}))
    ORDER BY "id" COLLATE "C" FOR SHARE
  `;
}

export function readStockAllocations(value: Prisma.JsonValue | null, lines: readonly CheckoutStockLine[]): StockAllocation[] {
  // Open payment sessions from before locations held their stock in the original pool.
  if (value === null) return lines.map(line => ({
    variantId: line.variantId, quantity: line.quantity, personalization: line.personalization ?? "",
    locationId: legacyLocationId, locationName: legacyLocationName,
  }));
  return z.array(allocationInput).min(1).parse(value);
}

export async function changeAllocatedStock(tx: Prisma.TransactionClient, allocations: readonly StockMovement[], reserve: boolean) {
  const variantIds = [...new Set(allocations.map(line => line.variantId))];
  if (!variantIds.length) return;
  await lockVariantInventory(tx, variantIds);
  if (await tx.variant.findFirst({ where: { id: { in: variantIds }, managedInventory: true }, select: { id: true } })) {
    throw new InventoryLocationError("Use the connected allocation workflow to change this stock.");
  }
  await applyAllocatedStock(tx, allocations, reserve);
}

async function applyAllocatedStock(tx: Prisma.TransactionClient, allocations: readonly StockMovement[], reserve: boolean) {
  const byVariant = new Map<string, Map<string, number>>();
  for (const { variantId, locationId, quantity } of allocations) {
    const locations = byVariant.get(variantId) ?? new Map<string, number>();
    locations.set(locationId, (locations.get(locationId) ?? 0) + quantity);
    byVariant.set(variantId, locations);
  }
  for (const [variantId, locations] of [...byVariant].sort(([left], [right]) => byId(left, right))) {
    for (const [locationId, quantity] of [...locations].sort(([left], [right]) => byId(left, right))) {
      const filter = reserve ? { available: { gte: quantity } } : {};
      const data = { available: reserve ? { decrement: quantity } : { increment: quantity } };
      const result = locationId === legacyLocationId
        ? await tx.inventory.updateMany({ where: { variantId, ...filter }, data })
        : await tx.locationInventory.updateMany({ where: { variantId, locationId, ...filter }, data });
      if (result.count !== 1) throw new InventoryLocationError(reserve
        ? "Stock changed. Return to your cart and review your quantities."
        : "The original stock record is missing. No units were restored.");
    }
  }
}

export async function reserveCheckoutStock(tx: Prisma.TransactionClient, marketId: MarketId, lines: readonly CheckoutStockLine[]) {
  const variantIds = [...new Set(lines.map(line => line.variantId))];
  await lockVariantInventory(tx, variantIds);
  await lockDispatchLocations(tx, variantIds);
  const variants = await tx.variant.findMany({ where: { id: { in: variantIds }, managedInventory: false }, include: {
    ...dispatchStockRelations,
    product: { select: { publication: true, demo: true, marketplaceShopId: true, marketplaceShop: { select: marketVisibilitySelect } } },
  } });
  const locationsByVariant = new Map(variants.filter(({ active, product }) =>
    active && product.publication === "ACTIVE" && merchantProductEligible(product, marketId),
  ).map(variant => [variant.id, stockLocations(variant, marketId, variant.product.marketplaceShopId)]));
  const requested = [...variantQuantities(lines)];
  const wholeOrderLocation = locationsByVariant.get(lines[0]?.variantId)?.find(({ locationId }) =>
    requested.every(([variantId, quantity]) =>
      (locationsByVariant.get(variantId)?.find(location => location.locationId === locationId)?.available ?? 0) >= quantity,
    ),
  );
  const allocations: StockAllocation[] = [];

  try {
    for (const line of lines) {
      let remaining = line.quantity;
      const pools = locationsByVariant.get(line.variantId) ?? [];
      const locations = wholeOrderLocation ? pools.filter(location => location.locationId === wholeOrderLocation.locationId) : pools;
      const single = locations.find(location => location.available >= remaining);
      for (const location of single ? [single] : locations) {
        const quantity = Math.min(remaining, location.available);
        if (!quantity) continue;
        allocations.push({ variantId: line.variantId, personalization: line.personalization ?? "", quantity,
          locationId: location.locationId, locationName: location.locationName });
        location.available -= quantity;
        remaining -= quantity;
        if (!remaining) break;
      }
      if (remaining) throw new InventoryLocationError("Stock changed. Return to your cart and review your quantities.");
    }
    await applyAllocatedStock(tx, allocations, true);
    return allocations;
  } catch (error) {
    if (error instanceof InventoryLocationError) throw new CommerceError({ kind: "unavailable", message: error.message });
    throw error;
  }
}

const orderLineKey = (line: CheckoutStockLine) => JSON.stringify([line.variantId, line.personalization ?? ""]);

export async function createOrderParcels(tx: Prisma.TransactionClient, orderId: string, allocations: readonly StockAllocation[]) {
  if (allocations.every(line => line.locationId === legacyLocationId)) return;
  const items = await tx.orderItem.findMany({ where: { orderId }, select: { id: true, variantId: true, personalization: true, quantity: true } });
  const itemsByLine = new Map(items.map(item => [orderLineKey(item), item]));
  const remaining = new Map(items.map(item => [item.id, item.quantity]));
  const parcels = new Map<string, { locationName: string; items: { orderItemId: string; quantity: number }[] }>();
  for (const allocation of allocations) {
    const item = itemsByLine.get(orderLineKey(allocation));
    if (!item) throw new InventoryLocationError("A dispatch allocation does not match an order item.");
    remaining.set(item.id, (remaining.get(item.id) ?? 0) - allocation.quantity);
    const parcel = parcels.get(allocation.locationId) ?? { locationName: allocation.locationName, items: [] };
    parcel.items.push({ orderItemId: item.id, quantity: allocation.quantity });
    parcels.set(allocation.locationId, parcel);
  }
  if ([...remaining.values()].some(quantity => quantity !== 0)) throw new InventoryLocationError("Dispatch quantities do not match the order.");
  for (const [locationId, { locationName, items: lines }] of parcels) {
    await tx.orderParcel.create({ data: {
      orderId, locationId, locationName, status: "PLANNED", preparationState: "PENDING", items: { createMany: { data: lines } },
      events: { create: { status: "PLANNED" } },
    } });
  }
}

export function parcelQuantitiesByLocation(lines: readonly { quantity: number; parcel: { locationId: string } }[]) {
  const quantities = new Map<string, number>();
  for (const { quantity, parcel: { locationId } } of lines) {
    quantities.set(locationId, (quantities.get(locationId) ?? 0) + quantity);
  }
  return quantities;
}

export async function restoreOrderInventory(tx: Prisma.TransactionClient, items: readonly LocationReceiptLine[]) {
  if (!items.length) return 0;
  if (await tx.orderItem.findFirst({
    where: { id: { in: items.map(line => line.id) }, OR: [
      { offerIdSnapshot: { not: null } }, { variant: { managedInventory: true } },
    ] },
    select: { id: true },
  })) throw new InventoryLocationError("Use the connected allocation workflow to restore this stock.");
  const parcelLines = await tx.orderParcelItem.findMany({
    where: { orderItemId: { in: items.map(line => line.id) } },
    select: { orderItemId: true, quantity: true, parcel: { select: { locationId: true } } },
    orderBy: { parcel: { locationId: "asc" } },
  });
  const receipts: StockMovement[] = [];
  for (const { id, variantId, quantity, receivedBefore } of items) {
    const sources = parcelQuantitiesByLocation(parcelLines.filter(line => line.orderItemId === id));
    if (!sources.size) {
      receipts.push({ variantId, locationId: legacyLocationId, quantity });
      continue;
    }
    const reserved = [...sources.values()].reduce((sum, units) => sum + units, 0);
    if (quantity + (receivedBefore ?? 0) > reserved) throw new InventoryLocationError("The receipt exceeds the original parcel quantities.");
    if (sources.size > 1 && quantity !== reserved) throw new InventoryLocationError("This item shipped from several locations. Hold this partial return to confirm where it should be restocked.");
    for (const [locationId, allocated] of sources) receipts.push({ variantId, locationId, quantity: sources.size === 1 ? quantity : allocated });
  }
  await changeAllocatedStock(tx, receipts, false);
  return receipts.reduce((sum, receipt) => sum + receipt.quantity, 0);
}
