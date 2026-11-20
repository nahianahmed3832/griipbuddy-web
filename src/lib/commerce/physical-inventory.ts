import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { Prisma, type InventoryMovementKind, type InventoryPool } from "../../generated/prisma/client.ts";
import { validVariantId } from "../cart/model.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable, marketConfiguration, marketIdInput, type MarketPaymentMethod } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { validationMessage } from "../staff/catalog-input.ts";
import { CatalogWriteError, OperationError } from "../staff/operation-error.ts";
import { contiguousStates, usPostalCode } from "./address.ts";
import { authorizeCommercialActor, connectedSellerVisibility, lockCommercialSeller, type CommercialActor } from "./commercial-access.ts";
import { integratedCheckout } from "./integrated-checkout.ts";
import { legacyLocationId, lockVariantInventory } from "./location-inventory.ts";
import { deliveryChoices } from "./orders.ts";
import { paypalCheckoutAvailability } from "./paypal-config.ts";

const maxStock = 1_000_000;
const districtInput = z.string().trim().toLowerCase().regex(/^[a-z][a-z-]{1,39}$/);
const methodInput = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{1,39}$/);
const locationInput = z.string().trim().min(1).max(96).refine(id => id !== legacyLocationId, "Choose a physical warehouse.");
const warehouseServiceInput = z.strictObject({
  locationId: locationInput, marketId: marketIdInput, active: z.boolean(), priority: z.int().min(0).max(1000),
  districts: z.array(districtInput).max(100).default([]), methods: z.array(methodInput).max(30).default([]),
}).refine(({ districts, methods }) =>
  new Set(districts).size === districts.length && new Set(methods).size === methods.length, "List each district and delivery method once.");
const poolInput = z.strictObject({ variantId: z.string().refine(validVariantId), locationId: locationInput });
const movementFields = {
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9._:/-]{1,120}$/),
  reason: z.string().trim().min(1).max(240),
  reference: z.string().trim().min(1).max(160),
};
const movementInput = z.strictObject({
  ...movementFields, poolId: z.uuid(), kind: z.enum(["RECEIPT", "ADJUSTMENT"]),
  quantity: z.int().min(-maxStock).max(maxStock).refine(quantity => quantity !== 0),
}).refine(({ kind, quantity }) => kind !== "RECEIPT" || quantity > 0, "A receipt quantity must be positive.");
const transferInput = z.strictObject({
  ...movementFields, fromPoolId: z.uuid(), toPoolId: z.uuid(), quantity: z.int().positive().max(maxStock),
}).refine(({ fromPoolId, toPoolId }) => fromPoolId !== toPoolId, "Choose two different warehouse pools.");

export const inventoryDestinationInput = z.strictObject({
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/), district: districtInput, method: methodInput,
  postalCode: z.string().trim().max(10).nullish(),
});
export type InventoryDestination = z.input<typeof inventoryDestinationInput>;
type Tx = Prisma.TransactionClient;
type WorkspaceStockContext = { marketId: MarketId; productId: string };
type WarehouseServiceTerms = Pick<z.output<typeof warehouseServiceInput>, "active" | "priority" | "districts" | "methods">;
type AvailablePool = InventoryPool & { available: number };
type PoolResult =
  | { kind: "delivery_unavailable"; pools: []; available: 0 }
  | { kind: "out_of_stock" | "available"; pools: AvailablePool[]; available: number };

function parseInput<T>(schema: z.ZodType<T>, raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new OperationError(validationMessage(parsed.error));
  return parsed.data;
}

function availableInventory<T extends { onHand: number; reserved: number }>(pool: T) {
  return { ...pool, available: pool.onHand - pool.reserved };
}

export async function lockInventoryMarketPolicy(tx: Tx, marketId: MarketId, destination: InventoryDestination) {
  const { district, method } = parseInput(inventoryDestinationInput, destination);
  await tx.$queryRaw`SELECT "marketId" FROM "CheckoutPolicy" WHERE "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
  await tx.$queryRaw`
    SELECT "district" FROM "DeliveryZone" WHERE "marketId" = ${marketId}::"MarketCode"
    AND "district" = ${district} AND "method" = ${method} FOR SHARE
  `;
}

export async function lockInventoryRoutes(tx: Tx, variantIds: readonly string[]) {
  if (!variantIds.length) return;
  // Service edits take an exclusive warehouse lock, including when inserting a new market edge.
  await tx.$queryRaw`
    SELECT id FROM "DispatchLocation" WHERE id IN (
      SELECT "locationId" FROM "InventoryPool" WHERE "variantId" IN (${Prisma.join([...new Set(variantIds)])})
    ) ORDER BY id COLLATE "C" FOR SHARE
  `;
}

async function acceptsSandboxPayPalDelivery(db: DbReader, marketId: MarketId) {
  if (!paypalCheckoutAvailability(marketId).paymentEnabled) return false;
  const market = marketConfiguration(marketId);
  if (market.pricing.taxTreatment !== "MERCHANDISE_RATE") return true;
  const policy = await db.checkoutPolicy.findUnique({ where: { marketId } });
  return Boolean(policy?.enabled && policy.countryCode === market.countryCode && policy.currency === market.currency &&
    policy.taxTreatment === market.pricing.taxTreatment && policy.taxBasisPoints !== null &&
    policy.taxBasisPoints >= 0 && policy.taxBasisPoints <= 10_000 && policy.taxLabel?.trim());
}

async function allowedDestination(db: DbReader, marketId: MarketId, paymentMethod: MarketPaymentMethod, destination: z.output<typeof inventoryDestinationInput>) {
  const { country, district, method, postalCode } = destination;
  const market = marketConfiguration(marketId);
  if (market.checkoutAuthority !== "native" || country !== market.countryCode || integratedCheckout(marketId)) return false;
  if (market.address.adapter === "us-postal") {
    if (!usPostalCode.safeParse(postalCode).success ||
      (!contiguousStates.has(district.toUpperCase()) && !["ak", "hi"].includes(district))) return false;
  } else if (postalCode && !/^\d{4}$/.test(postalCode)) return false;
  if (paymentMethod === "PAYPAL") {
    return method === "sandbox-standard" && contiguousStates.has(district.toUpperCase()) && acceptsSandboxPayPalDelivery(db, marketId);
  }
  const choices = await deliveryChoices(marketId, paymentMethod, db);
  return choices.some(zone => zone.district === district && zone.method === method && zone.chargeMinor >= 0);
}

type DeliveryScope = { marketId: MarketId; paymentMethod: MarketPaymentMethod; destination: InventoryDestination };
type PoolScope = { variantId: string; ownerId: string };
const noDelivery = { kind: "delivery_unavailable", pools: [], available: 0 } satisfies PoolResult;

export const inventoryPoolScopeKey = ({ variantId, ownerId }: PoolScope) => JSON.stringify([variantId, ownerId]);

function warehouseForPool(ownerId: string, route: Prisma.DispatchLocationMarketWhereInput): Prisma.DispatchLocationWhereInput {
  return { id: { not: legacyLocationId }, active: true, marketServices: { some: route },
    ...(ownerId === storeShop.id ? { OR: [{ shopId: null }, { shopId: ownerId }] } : { shopId: ownerId }) };
}

// Market-wide discovery only. Checkout still validates the shopper's precise
// destination and quantities. Each pool counts once even if it has several routes.
export async function marketRoutedInventory(db: DbReader, marketId: MarketId, offers: readonly PoolScope[]) {
  const totals = new Map<string, number>();
  if (!offers.length) return totals;
  const market = marketConfiguration(marketId);
  if (market.status === "planned" || market.status === "paused" || market.checkoutAuthority !== "native" || integratedCheckout(marketId)) return totals;
  const [cod, prepaid, paypal] = await Promise.all([
    deliveryChoices(marketId, "COD", db), deliveryChoices(marketId, "SSLCOMMERZ", db), acceptsSandboxPayPalDelivery(db, marketId),
  ]);
  const routes = [...cod, ...prepaid].filter(zone => zone.chargeMinor >= 0).map(({ district, method }) => ({ district, method }));
  if (paypal) {
    for (const state of contiguousStates) routes.push({ district: state.toLowerCase(), method: "sandbox-standard" });
  }
  if (!routes.length) return totals;
  const variantsByOwner = new Map<string, Set<string>>();
  for (const { ownerId, variantId } of offers) {
    const ids = variantsByOwner.get(ownerId) ?? new Set<string>();
    ids.add(variantId);
    variantsByOwner.set(ownerId, ids);
  }
  const rows = await db.inventoryPool.findMany({
    where: { onHand: { gt: 0 }, owner: connectedSellerVisibility(marketId), variant: { managedInventory: true },
      OR: [...variantsByOwner].map(([ownerId, ids]) => ({ ownerId, variantId: { in: [...ids] },
        location: warehouseForPool(ownerId, { marketId, active: true }) })) },
    select: { ownerId: true, variantId: true, onHand: true, reserved: true,
      location: { select: { marketServices: { where: { marketId, active: true }, select: { districts: true, methods: true } } } } },
  });
  for (const row of rows) {
    const { available } = availableInventory(row);
    if (available <= 0 || !row.location.marketServices.some(({ districts, methods }) => routes.some(({ district, method }) =>
      (!districts.length || districts.includes(district)) && (!methods.length || methods.includes(method))))) continue;
    const key = inventoryPoolScopeKey(row);
    totals.set(key, (totals.get(key) ?? 0) + available);
  }
  return totals;
}

export async function marketInventoryAvailability(db: DbReader, scope: DeliveryScope, offers: readonly PoolScope[]) {
  const { marketId, paymentMethod } = scope;
  const poolsByOffer = new Map<string, PoolResult>();
  const destination = inventoryDestinationInput.safeParse(scope.destination);
  const acceptsDestination = isMarketSelectable(marketId) && destination.success &&
    await allowedDestination(db, marketId, paymentMethod, destination.data);
  if (!acceptsDestination || !destination.success || !offers.length) return { acceptsDestination, poolsByOffer };
  const { district, method } = destination.data;
  const sellers = await db.marketplaceShop.findMany({ where: {
    AND: [{ id: { in: [...new Set(offers.map(offer => offer.ownerId))] } }, connectedSellerVisibility(marketId)],
  }, select: { id: true } });
  const variantsByOwner = new Map(sellers.map(seller => [seller.id, new Set<string>()]));
  for (const offer of offers) variantsByOwner.get(offer.ownerId)?.add(offer.variantId);
  if (!variantsByOwner.size) return { acceptsDestination, poolsByOffer };

  const routeScope = { marketId, active: true, AND: [
    { OR: [{ districts: { isEmpty: true } }, { districts: { has: district } }] },
    { OR: [{ methods: { isEmpty: true } }, { methods: { has: method } }] },
  ] } satisfies Prisma.DispatchLocationMarketWhereInput;
  const rows = await db.inventoryPool.findMany({ where: {
    variant: { managedInventory: true },
    OR: [...variantsByOwner].map(([ownerId, variants]) => ({ ownerId, variantId: { in: [...variants] },
      location: warehouseForPool(ownerId, routeScope) })),
  }, include: { location: { select: { marketServices: { where: routeScope, select: { priority: true } } } } } });
  const routed = rows.flatMap(({ location, ...pool }) => location.marketServices[0] ?
    [{ pool, priority: location.marketServices[0].priority }] : []);
  routed.sort((a, b) => a.priority - b.priority ||
    (a.pool.locationId < b.pool.locationId ? -1 : a.pool.locationId > b.pool.locationId ? 1 : 0));
  for (const { pool: row } of routed) {
    const key = inventoryPoolScopeKey(row);
    const pool = availableInventory(row);
    const previous = poolsByOffer.get(key);
    const available = (previous?.available ?? 0) + pool.available;
    const result: PoolResult = previous && previous.kind !== "delivery_unavailable" ? previous :
      { kind: "out_of_stock", pools: [], available: 0 };
    result.kind = available ? "available" : "out_of_stock";
    result.available = available;
    result.pools.push(pool);
    poolsByOffer.set(key, result);
  }
  return { acceptsDestination, poolsByOffer };
}

export async function eligibleInventoryPools(db: DbReader, request: DeliveryScope & PoolScope): Promise<PoolResult> {
  const { poolsByOffer } = await marketInventoryAvailability(db, request, [request]);
  return poolsByOffer.get(inventoryPoolScopeKey(request)) ?? noDelivery;
}

async function authorizeWarehouse(tx: Tx, actor: CommercialActor, locationId: string, routeMarket?: MarketId) {
  const initial = await tx.dispatchLocation.findUnique({ where: { id: locationId }, select: { shopId: true, marketId: true } });
  if (!initial?.marketId || locationId === legacyLocationId) throw new OperationError("Choose a physical warehouse.");
  const ownerId = initial.shopId ?? storeShop.id;
  await lockCommercialSeller(tx, ownerId);
  if (routeMarket) await tx.$queryRaw`SELECT id FROM "DispatchLocation" WHERE id = ${locationId} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM "DispatchLocation" WHERE id = ${locationId} FOR SHARE`;
  const current = await tx.dispatchLocation.findUnique({ where: { id: locationId }, select: { shopId: true, marketId: true } });
  if (!current?.marketId || current.marketId !== initial.marketId || (current.shopId ?? storeShop.id) !== ownerId) {
    throw new OperationError("The warehouse changed. Reload and try again.");
  }
  const entryMarket = routeMarket ?? current.marketId;
  const permission = await authorizeCommercialActor(tx, actor, { marketId: entryMarket, sellerId: ownerId });
  if (!permission.central) {
    const routes = await tx.dispatchLocationMarket.findMany({
      where: { locationId, active: true }, orderBy: { marketId: "asc" }, select: { marketId: true },
    });
    const markets = new Set([current.marketId, ...routes.map(route => route.marketId)]);
    markets.delete(entryMarket);
    for (const marketId of markets) await authorizeCommercialActor(tx, actor, { marketId, sellerId: ownerId });
  }
  return ownerId;
}

async function assertWorkspaceWarehouse(tx: Tx, locationId: string, marketId: MarketId) {
  if (!await tx.dispatchLocation.findFirst({
    where: { id: locationId, OR: [{ marketId }, { marketServices: { some: { marketId, active: true } } }] },
    select: { id: true },
  })) throw new CatalogWriteError("forbidden", "This warehouse is outside the selected market.");
}

async function assertWorkspaceVariant(tx: Tx, actor: CommercialActor, variantId: string, scope: WorkspaceStockContext, ownerId: string) {
  await tx.$queryRaw`
    SELECT p.id FROM "Product" p JOIN "Variant" v ON v."productId" = p.id WHERE v.id = ${variantId} FOR SHARE OF p
  `;
  if (!await tx.variant.findFirst({ where: {
    id: variantId, productId: scope.productId,
    ...(actor.kind === "seller" && { OR: [
      { product: { marketplaceShopId: ownerId } },
      { offers: { some: { marketId: scope.marketId, identity: { sellerId: ownerId, retiredAt: null } } } },
    ] }),
  }, select: { id: true } })) throw new CatalogWriteError("forbidden", "This stock is outside the selected product.");
}

export async function saveWarehouseService(actor: CommercialActor, raw: unknown, expected?: WarehouseServiceTerms | null) {
  const { locationId, marketId, ...data } = parseInput(warehouseServiceInput, raw);
  return getDb().$transaction(async tx => {
    const ownerId = await authorizeWarehouse(tx, actor, locationId, marketId);
    if (data.active && (!isMarketSelectable(marketId) || !await tx.marketplaceShop.findFirst({
      where: { AND: [{ id: ownerId }, connectedSellerVisibility(marketId)] }, select: { id: true },
    }))) {
      throw new OperationError("The warehouse owner is not approved to serve this market.");
    }
    if (expected !== undefined) {
      const current = await tx.dispatchLocationMarket.findUnique({
        where: { locationId_marketId: { locationId, marketId } },
        select: { active: true, priority: true, districts: true, methods: true },
      });
      if (current?.active !== expected?.active || current?.priority !== expected?.priority ||
        JSON.stringify(current?.districts) !== JSON.stringify(expected?.districts) ||
        JSON.stringify(current?.methods) !== JSON.stringify(expected?.methods)) {
        throw new CatalogWriteError("conflict", "Warehouse service changed. Reload before saving.");
      }
    }
    const service = await tx.dispatchLocationMarket.upsert({
      where: { locationId_marketId: { locationId, marketId } },
      create: { locationId, marketId, ...data },
      update: data,
    });
    await tx.auditEvent.create({ data: {
      actorId: actor.kind === "staff" ? actor.id : null, action: "MARKET_SETTINGS_CHANGED", target: locationId,
      changes: { setting: "warehouse service", actor, marketId, ...data },
    } });
    return service;
  });
}

export async function initializeInventoryPool(actor: CommercialActor, raw: unknown, scope?: WorkspaceStockContext) {
  const { variantId, locationId } = parseInput(poolInput, raw);
  return getDb().$transaction(async tx => {
    await lockVariantInventory(tx, [variantId]);
    await tx.$queryRaw`SELECT id FROM "Variant" WHERE id = ${variantId} FOR NO KEY UPDATE`;
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: {
      optionSignature: true, active: true, managedInventory: true, product: { select: { foundation: true } },
      inventory: { select: { variantId: true } }, _count: { select: { locationInventory: true } },
      offers: { where: { offerId: null }, take: 1, select: { marketId: true } },
    } });
    if (!variant?.product.foundation || variant.optionSignature === null) throw new OperationError("Choose a structured catalog variant.");
    const ownerId = await authorizeWarehouse(tx, actor, locationId);
    if (scope) {
      await assertWorkspaceVariant(tx, actor, variantId, scope, ownerId);
      await assertWorkspaceWarehouse(tx, locationId, scope.marketId);
      if (!variant.active) throw new OperationError("Choose an active variant before opening a stock pool.");
    }
    if (variant.inventory || variant._count.locationInventory) throw new OperationError("Reconcile legacy inventory before enrolling this variant.");
    if (variant.offers.length) throw new OperationError("Reconcile legacy market offers before enrolling this variant.");
    if (!variant.managedInventory) {
      await tx.variant.update({ where: { id: variantId }, data: { managedInventory: true } });
    }
    const key = { variantId, locationId, ownerId };
    const previous = await tx.inventoryPool.findUnique({ where: { variantId_ownerId_locationId: key } });
    if (previous) return availableInventory(previous);
    const pool = await tx.inventoryPool.create({ data: key });
    await tx.auditEvent.create({ data: {
      action: "STOCK_CHANGED", actorId: actor.kind === "staff" ? actor.id : null, target: variantId,
      changes: { source: "inventory-pool-opened", actor, poolId: pool.id, locationId, ownerId, onHand: 0 },
    } });
    return availableInventory(pool);
  });
}

type Movement = {
  poolId: string; kind: InventoryMovementKind; quantity: number; reservedDelta?: number;
  idempotencyKey: string; reason: string; reference: string; actorId?: string; allocationId?: string; relatedPoolId?: string;
};

// The caller holds the variant inventory lock and authorizes the referenced operation.
export async function applyInventoryMovement(tx: Tx, movement: Movement, expectedUpdatedAt?: Date) {
  const { poolId, kind, quantity, idempotencyKey, reason, reference, reservedDelta = 0 } = movement;
  const data = { poolId, kind, quantity, idempotencyKey, reason, reference, actorId: movement.actorId ?? null,
    allocationId: movement.allocationId ?? null, relatedPoolId: movement.relatedPoolId ?? null };
  const negative = kind === "DISPATCH" || kind === "TRANSFER_OUT";
  if (!Number.isInteger(quantity) || quantity === 0 || (kind !== "ADJUSTMENT" && (quantity < 0) !== negative) ||
    (kind === "DISPATCH" ? reservedDelta !== quantity : reservedDelta !== 0) ||
    ((kind === "DISPATCH" || kind === "RETURN") !== Boolean(data.allocationId)) ||
    ((kind === "TRANSFER_OUT" || kind === "TRANSFER_IN") !== Boolean(data.relatedPoolId))) {
    throw new OperationError("Invalid stock movement.");
  }
  const previous = await tx.inventoryMovement.findUnique({ where: { poolId_idempotencyKey: { poolId, idempotencyKey } } });
  if (previous) {
    if (previous.kind !== kind || previous.quantity !== quantity || previous.reason !== reason ||
      previous.reference !== reference || previous.actorId !== data.actorId || previous.allocationId !== data.allocationId ||
      previous.relatedPoolId !== data.relatedPoolId) throw new OperationError("This stock movement key already belongs to a different event.");
    return { movement: previous, replayed: true };
  }
  const pool = await tx.inventoryPool.findUniqueOrThrow({ where: { id: poolId } });
  if (expectedUpdatedAt && pool.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw new CatalogWriteError("conflict", "Warehouse stock or reservations changed. Reload before recording this movement.");
  }
  const onHand = pool.onHand + quantity;
  const reserved = pool.reserved + reservedDelta;
  if (onHand > maxStock || reserved < 0 || onHand < reserved) {
    throw new OperationError("The movement would exceed available stock or the supported warehouse balance.");
  }
  const updated = await tx.inventoryPool.updateMany({
    where: { id: poolId, onHand: pool.onHand, reserved: pool.reserved }, data: { onHand, reserved },
  });
  if (updated.count !== 1) throw new OperationError("Warehouse stock changed. Reload before recording this movement.");
  return { movement: await tx.inventoryMovement.create({ data }), replayed: false };
}

async function stockPoolScope(tx: Tx, actor: CommercialActor, pool: InventoryPool, scope?: WorkspaceStockContext) {
  if (await authorizeWarehouse(tx, actor, pool.locationId) !== pool.ownerId) {
    throw new OperationError("The warehouse no longer belongs to this pool owner.");
  }
  if (scope) {
    await assertWorkspaceVariant(tx, actor, pool.variantId, scope, pool.ownerId);
    await assertWorkspaceWarehouse(tx, pool.locationId, scope.marketId);
  }
}

export async function recordStockMovement(actor: CommercialActor, raw: unknown,
  scope?: WorkspaceStockContext & { expectedUpdatedAt: Date }) {
  const input = parseInput(movementInput, raw);
  return getDb().$transaction(async tx => {
    const pool = await tx.inventoryPool.findUnique({ where: { id: input.poolId } });
    if (!pool) throw new OperationError("Choose an existing warehouse pool.");
    await lockVariantInventory(tx, [pool.variantId]);
    await stockPoolScope(tx, actor, pool, scope);
    return applyInventoryMovement(tx, { ...input, actorId: actor.id }, scope?.expectedUpdatedAt);
  });
}

export async function transferStock(actor: CommercialActor, raw: unknown,
  scope?: WorkspaceStockContext & { expectedUpdatedAt: Date; expectedDestinationUpdatedAt: Date }) {
  const { fromPoolId, toPoolId, quantity, ...input } = parseInput(transferInput, raw);
  return getDb().$transaction(async tx => {
    const pools = await tx.inventoryPool.findMany({ where: { id: { in: [fromPoolId, toPoolId] } }, orderBy: { locationId: "asc" } });
    const from = pools.find(pool => pool.id === fromPoolId);
    const to = pools.find(pool => pool.id === toPoolId);
    if (!from || !to || from.ownerId !== to.ownerId || from.variantId !== to.variantId) {
      throw new OperationError("Stock transfers require the same owner and SKU at both warehouses.");
    }
    await lockVariantInventory(tx, [from.variantId]);
    for (const pool of pools) await stockPoolScope(tx, actor, pool, scope);
    const sent = await applyInventoryMovement(tx, {
      ...input, actorId: actor.id, poolId: fromPoolId, relatedPoolId: toPoolId, kind: "TRANSFER_OUT", quantity: -quantity,
    }, scope?.expectedUpdatedAt);
    const received = await applyInventoryMovement(tx, {
      ...input, actorId: actor.id, poolId: toPoolId, relatedPoolId: fromPoolId, kind: "TRANSFER_IN", quantity,
    }, scope?.expectedDestinationUpdatedAt);
    if (sent.replayed !== received.replayed) throw new OperationError("This transfer reference is incomplete.");
    return { sent: sent.movement, received: received.movement, replayed: sent.replayed };
  });
}
