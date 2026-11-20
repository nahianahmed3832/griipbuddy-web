import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { validVariantId } from "../cart/model.ts";
import { inventoryShopId, legacyLocationId, lockVariantInventory } from "../commerce/location-inventory.ts";
import { storeShop } from "../marketplace/constants.ts";
import { authorize, OperationError, staffStockChangeInput } from "./operations.ts";

const stockLimit = 1_000_000;
const locationInput = z.object({
  name: z.string().trim().min(3).max(80),
  marketId: z.enum(["bd", "us"]),
  shopId: z.uuid().nullable(),
  priority: z.number().int().min(0).max(1000),
});
const locationId = z.string().trim().min(1).max(96).refine(id => id !== legacyLocationId);
const locationStockInput = staffStockChangeInput.extend({ locationId });
const adoptionInput = z.object({
  variantId: z.string().refine(validVariantId), locationId,
  expectedAvailable: z.number().int().min(0).max(stockLimit),
  reason: staffStockChangeInput.shape.reason,
});

export async function staffDispatchLocations(actorId: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  const [locations, sellers] = await Promise.all([
    db.dispatchLocation.findMany({ where: { marketId: { not: null } }, orderBy: [{ priority: "asc" }, { name: "asc" }, { id: "asc" }] }),
    db.marketplaceShop.findMany({
      where: { id: { not: storeShop.id } },
      select: { id: true, name: true, published: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  return { locations, sellers };
}

export async function createDispatchLocation(actorId: string, input: unknown) {
  const parsed = locationInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter a location name, market, owner, and a priority from 0 to 1,000.");
  const { name, marketId, priority } = parsed.data;
  const shopId = inventoryShopId(parsed.data.shopId);
  await getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    if (shopId && !await tx.marketplaceShop.findFirst({
      where: { id: shopId, published: true, marketGrants: { some: { marketId, status: "APPROVED" } } }, select: { id: true },
    })) {
      throw new OperationError("Select a published seller approved for this market.");
    }
    const location = await tx.dispatchLocation.create({ data: { name, marketId, priority, shopId } });
    await tx.auditEvent.create({ data: {
      actorId, action: "MARKET_SETTINGS_CHANGED", target: location.id,
      changes: { setting: "dispatch location", name, marketId, priority, shopId },
    } });
  });
}

async function stockContext(tx: Prisma.TransactionClient, variantId: string, dispatchId: string) {
  await lockVariantInventory(tx, [variantId]);
  const variant = await tx.variant.findUnique({ where: { id: variantId }, select: {
    managedInventory: true, product: { select: { marketplaceShopId: true } }, inventory: { select: { available: true } },
    locationInventory: { select: { locationId: true, available: true } },
  } });
  const location = await tx.dispatchLocation.findUnique({ where: { id: dispatchId } });
  if (variant?.managedInventory) throw new OperationError("Use owner and warehouse inventory for this variant.");
  if (!variant || !location?.marketId || inventoryShopId(location.shopId) !== inventoryShopId(variant.product.marketplaceShopId)) {
    throw new OperationError("Choose a location that belongs to this variant’s stock owner.");
  }
  return { variant, location, available: variant.locationInventory.find(row => row.locationId === dispatchId)?.available ?? 0 };
}

export async function adjustLocationStock(actorId: string, input: unknown) {
  const parsed = locationStockInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose a dispatch location and enter a nonzero whole-unit stock adjustment and a reason.");
  const { variantId, locationId, delta, reason } = parsed.data;
  await getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    const { variant, available } = await stockContext(tx, variantId, locationId);
    if (!variant.locationInventory.length && (variant.inventory?.available ?? 0) > 0) {
      throw new OperationError("Move the shared stock to a dispatch location before adding stock by location.");
    }
    const adjusted = available + delta;
    if (adjusted < 0 || adjusted > stockLimit) throw new OperationError("That adjustment would move stock outside the supported range.");
    await tx.locationInventory.upsert({
      where: { variantId_locationId: { variantId, locationId } },
      create: { variantId, locationId, available: adjusted }, update: { available: adjusted },
    });
    await tx.auditEvent.create({ data: {
      actorId, action: "STOCK_CHANGED", target: variantId, changes: { locationId, before: available, after: adjusted, delta, reason },
    } });
  });
}

export async function moveSharedStockToLocation(actorId: string, input: unknown) {
  const parsed = adoptionInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose a dispatch location and enter a reason for moving stock.");
  const { variantId, locationId, expectedAvailable, reason } = parsed.data;
  await getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    const { variant, location, available } = await stockContext(tx, variantId, locationId);
    if (!location.active) throw new OperationError("Choose an active location for these units.");
    const shared = variant.inventory?.available ?? 0;
    if (shared !== expectedAvailable) throw new OperationError("Shared stock changed. Refresh the page and review the available units before moving them.");
    if (shared === 0 && variant.locationInventory.length) throw new OperationError("There are no shared units to move.");
    const total = available + shared;
    if (total > stockLimit) throw new OperationError("The selected location would exceed its supported stock count.");
    if (shared > 0) {
      const result = await tx.inventory.updateMany({ where: { variantId, available: shared }, data: { available: 0 } });
      if (result.count !== 1) throw new OperationError("Shared stock changed. Refresh the page and try again.");
    }
    await tx.locationInventory.upsert({
      where: { variantId_locationId: { variantId, locationId } },
      create: { variantId, locationId, available: total }, update: { available: total },
    });
    await tx.auditEvent.create({ data: {
      actorId, action: "STOCK_CHANGED", target: variantId,
      changes: { fromLocationId: legacyLocationId, toLocationId: locationId, units: shared, before: available, after: total, reason },
    } });
  });
}
