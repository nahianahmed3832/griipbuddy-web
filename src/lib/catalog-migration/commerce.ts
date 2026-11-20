import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import type { MarketOffer, Prisma } from "../../generated/prisma/client.ts";
import { validVariantId } from "../cart/model.ts";
import { legacyLocationId, lockVariantInventory } from "../commerce/location-inventory.ts";
import { applyInventoryMovement, inventoryDestinationInput } from "../commerce/physical-inventory.ts";
import type { DbReader } from "../db/client.ts";
import { marketIdInput } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { inspectCommerceRisk } from "./commerce-risk.ts";
import { mappingTargetId, migrationDigest, migrationVersion, nativeSourceSystem, type MigrationIssue, type MigrationMapping } from "./contracts.ts";

const variantIdInput = z.string().refine(validVariantId);
const warehouseIdInput = z.string().trim().min(1).max(96).refine(id => id !== legacyLocationId, "Use a physical warehouse.");
const ownerIdInput = z.uuid().transform(id => id.toLowerCase());
const balanceInput = z.number().int().min(0).max(1_000_000);

const sourceBalanceInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("shared"), retired: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal("location"), locationId: warehouseIdInput }),
]);
const warehouseRouteInput = z.strictObject({
  marketId: marketIdInput,
  priority: z.number().int().min(0).max(1000).default(100),
  districts: z.array(inventoryDestinationInput.shape.district).max(100).default([]),
  methods: z.array(inventoryDestinationInput.shape.method).max(30).default([]),
});
const offerEvidenceInput = z.strictObject({
  variantId: variantIdInput, marketId: marketIdInput, sellerId: ownerIdInput,
  currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: z.number().int().min(1).max(2_147_483_647),
});
const inventoryEvidenceInput = z.strictObject({
  variantId: variantIdInput, ownerId: ownerIdInput, locationId: warehouseIdInput,
  onHand: balanceInput, reserved: balanceInput, allocated: balanceInput,
  evidence: z.string().trim().min(3).max(160),
  legacySources: z.array(sourceBalanceInput).min(1).max(100),
  routes: z.array(warehouseRouteInput).min(1).max(20),
});

export const commerceManifestInput = z.strictObject({
  offers: z.array(offerEvidenceInput).max(2000),
  inventory: z.array(inventoryEvidenceInput).max(2000),
});
export type CommerceManifest = z.output<typeof commerceManifestInput>;

type Route = z.output<typeof warehouseRouteInput> & { locationId: string; active: boolean };
type StockInstruction = CommerceManifest["inventory"][number];
type SourceBalance = StockInstruction["legacySources"][number];
type OfferPlan = { id: string; source: MarketOffer; sellerId: string };
type PoolPlan = StockInstruction & { id: string };
type CommercePlan = Awaited<ReturnType<typeof inspectCommerce>>;
type ExplicitSeller = {
  id: string;
  published: boolean;
  marketGrants: { marketId: MarketId; status: string }[];
};

function offerKey(variantId: string, marketId: string) {
  return mappingTargetId(variantId, marketId);
}

function sourceBalanceKey(variantId: string, source: SourceBalance) {
  return source.kind === "shared" ? mappingTargetId(variantId, "shared") : mappingTargetId(variantId, "location", source.locationId);
}

function stockPoolKey({ variantId, ownerId, locationId }: Pick<StockInstruction, "variantId" | "ownerId" | "locationId">) {
  return mappingTargetId(variantId, ownerId, locationId);
}

function stableId(...parts: string[]) {
  const key = migrationDigest([migrationVersion, ...parts]);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-8${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

function authorizedSeller(seller: ExplicitSeller | undefined, marketId: MarketId) {
  return !!seller?.published && (seller.id === storeShop.id ||
    seller.marketGrants.some(grant => grant.marketId === marketId && grant.status === "APPROVED"));
}

function validPromotion(offer: MarketOffer) {
  const { discountMinor, discountStartsAt, discountEndsAt } = offer;
  if (discountMinor === null) return discountStartsAt === null && discountEndsAt === null;
  return discountMinor > 0 && discountMinor < offer.amountMinor &&
    discountStartsAt !== null && discountEndsAt !== null && discountStartsAt < discountEndsAt;
}

function routeKey({ locationId, marketId }: Pick<Route, "locationId" | "marketId">) {
  return mappingTargetId(locationId, marketId);
}

function routeDigest(route: Route) {
  return migrationDigest({ ...route, districts: [...route.districts].sort(), methods: [...route.methods].sort() });
}

function matchingId<T>(items: T[], key: (item: T) => string, onDuplicate: (id: string) => void) {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) onDuplicate(id);
    else result.set(id, item);
  }
  return result;
}

function commerceMappings(offers: OfferPlan[], pools: PoolPlan[], routes: Route[]) {
  const mappings: MigrationMapping[] = [];
  const map = (entity: string, sourceId: string, targetId: string) =>
    mappings.push({ sourceSystem: nativeSourceSystem, entity, sourceId, targetId });
  for (const row of offers) map("offer", offerKey(row.source.variantId, row.source.marketId), row.id);
  for (const route of routes) {
    const id = routeKey(route);
    map("warehouse-route", id, id);
  }
  for (const row of pools) {
    for (const legacy of row.legacySources) map("stock", sourceBalanceKey(row.variantId, legacy), row.id);
    map("warehouse", row.locationId, row.locationId);
  }
  return [...new Map(mappings.map(row => [mappingTargetId(row.entity, row.sourceId), row])).values()];
}

async function commerceSource(db: DbReader, variantIds: string[], instructions: CommerceManifest) {
  const warehouseIds = new Set(instructions.inventory.flatMap(row => [
    row.locationId, ...row.legacySources.flatMap(source => source.kind === "location" ? [source.locationId] : []),
  ]));
  const sellerIds = [...new Set([...instructions.offers.map(row => row.sellerId), ...instructions.inventory.map(row => row.ownerId)])];
  const variant = { in: variantIds };
  const variants = await db.variant.findMany({
    where: { id: variant }, orderBy: { id: "asc" },
    select: { id: true, productId: true, managedInventory: true, product: { select: { marketplaceShopId: true } } },
  });
  const offers = await db.marketOffer.findMany({ where: { variantId: variant }, orderBy: [{ variantId: "asc" }, { marketId: "asc" }] });
  const identities = await db.marketOfferIdentity.findMany({
    where: { variantId: variant }, orderBy: { id: "asc" },
    select: { id: true, variantId: true, marketId: true, sellerId: true, retiredAt: true },
  });
  const shared = await db.inventory.findMany({ where: { variantId: variant }, orderBy: { variantId: "asc" } });
  const named = await db.locationInventory.findMany({
    where: { variantId: variant }, orderBy: [{ variantId: "asc" }, { locationId: "asc" }],
  });
  for (const balance of named) warehouseIds.add(balance.locationId);
  const warehouses = await db.dispatchLocation.findMany({
    where: { id: { in: [...warehouseIds] } }, orderBy: { id: "asc" },
    select: { id: true, shopId: true, marketId: true, active: true, priority: true },
  });
  const routes = await db.dispatchLocationMarket.findMany({
    where: { locationId: { in: [...warehouseIds] } }, orderBy: [{ locationId: "asc" }, { marketId: "asc" }],
  });
  const sellers = await db.marketplaceShop.findMany({
    where: { id: { in: sellerIds } }, orderBy: { id: "asc" },
    select: { id: true, published: true, marketGrants: { select: { marketId: true, status: true }, orderBy: { marketId: "asc" } } },
  });
  const existingPools = await db.inventoryPool.findMany({
    where: { variantId: variant }, orderBy: { id: "asc" }, select: {
      id: true, variantId: true, ownerId: true, locationId: true, onHand: true, reserved: true,
    },
  });
  return { observed: { variants, offers, identities, shared, named, warehouses, sellers, existingPools }, routes };
}

export async function inspectCommerce(db: DbReader, variantIds: readonly string[], instructions: CommerceManifest) {
  const { observed: data, routes } = await commerceSource(db, [...new Set(variantIds)], instructions);
  const risk = await inspectCommerceRisk(db, variantIds);
  const issues: MigrationIssue[] = [...risk.issues];
  const issue = (code: string, reference: string, message: string) => issues.push({ code, reference, message });
  const variants = new Map(data.variants.map(variant => [variant.id, variant]));
  const sellers = new Map(data.sellers.map(seller => [seller.id, seller]));
  const warehouses = new Map(data.warehouses.map(warehouse => [warehouse.id, warehouse]));
  const offerRows = new Map(data.offers.map(row => [offerKey(row.variantId, row.marketId), row]));
  const offered = matchingId(instructions.offers, row => offerKey(row.variantId, row.marketId), id =>
    issue("duplicate_offer_mapping", id, "More than one market and seller instruction claims this legacy price."));
  for (const id of offered.keys()) if (!offerRows.has(id)) issue("unknown_legacy_offer", id, "Offer evidence references a missing or out-of-scope legacy market price.");

  const offerPlans: OfferPlan[] = [];
  for (const [id, row] of offerRows) {
    const evidence = offered.get(id);
    if (row.offerId || data.identities.some(identity => identity.variantId === row.variantId && identity.marketId === row.marketId)) {
      issue("connected_offer_overlap", id, "The market price already has a connected offer identity. Keep that authority and reconcile the mapping.");
    }
    if (!evidence) {
      issue("missing_offer_evidence", id, "Supply exact amount, currency and the verified seller and market for this legacy price.");
      continue;
    }
    if (row.currency !== markets[row.marketId].currency || row.currency !== evidence.currency ||
      row.amountMinor !== evidence.amountMinor || row.amountMinor <= 0 || row.revision < 0 || !validPromotion(row)) {
      issue("invalid_offer_terms", id, "The legacy price, promotion or currency does not match the verified market terms.");
    }
    const expectedSeller = variants.get(row.variantId)?.product.marketplaceShopId ?? storeShop.id;
    if (expectedSeller !== evidence.sellerId || !authorizedSeller(sellers.get(evidence.sellerId), row.marketId)) {
      issue("unverified_seller", id, "This seller differs from the legacy owner or lacks publication and market approval.");
    }
    offerPlans.push({ id: stableId("offer", row.variantId, row.marketId), source: row, sellerId: evidence.sellerId });
  }

  const sourceRows = new Map([
    ...data.shared.map(row => [sourceBalanceKey(row.variantId, { kind: "shared", retired: false }), row] as const),
    ...data.named.map(row => [sourceBalanceKey(row.variantId, { kind: "location", locationId: row.locationId }), row] as const),
  ]);
  const requestedPools = matchingId(instructions.inventory, stockPoolKey, id =>
    issue("duplicate_physical_pool", id, "Multiple inventory instructions describe the same physical item, owner and warehouse."));
  const existingRoutes = new Map(routes.map(route => [routeKey(route), route]));
  const requestedRoutes = new Map<string, Route>();
  const routeSets = new Map<string, string>();
  const routeConflicts = new Map<string, Route>();
  const consumed = new Map<string, string>();
  const poolPlans: PoolPlan[] = [];
  const stockReport: {
    variantId: string; ownerId: string; locationId: string; onHand: number; reserved: number; allocated: number;
    available: number; countedRepresentations: number; duplicateRepresentations: number; legacyAmounts: number[];
  }[] = [];

  for (const variant of data.variants) {
    if (variant.managedInventory || data.existingPools.some(pool => pool.variantId === variant.id)) {
      issue("connected_inventory_overlap", variant.id, "This variant already uses a connected stock pool. Reconcile the overlap before migration.");
    }
  }

  for (const [poolKey, row] of requestedPools) {
    const warehouse = warehouses.get(row.locationId);
    const variant = variants.get(row.variantId);
    if (!variant || !warehouse?.marketId || !warehouse.active || (warehouse.shopId ?? storeShop.id) !== row.ownerId) {
      issue("invalid_inventory_scope", poolKey, "Choose a scoped variant and its verified active warehouse and owner.");
    }
    const marketsWithRoute = new Set<MarketId>();
    for (const routeInput of row.routes) {
      if (marketsWithRoute.has(routeInput.marketId) || new Set(routeInput.districts).size !== routeInput.districts.length ||
        new Set(routeInput.methods).size !== routeInput.methods.length) {
        issue("duplicate_warehouse_route", poolKey, "Supply one warehouse route per market with distinct districts and methods.");
      }
      marketsWithRoute.add(routeInput.marketId);
      if (!authorizedSeller(sellers.get(row.ownerId), routeInput.marketId)) {
        issue("unverified_warehouse_market", poolKey, "The verified owner lacks permission to serve a requested warehouse market.");
      }
      const route = { ...routeInput, locationId: row.locationId, active: true };
      const id = routeKey(route);
      const earlier = requestedRoutes.get(id);
      if (earlier && routeDigest(earlier) !== routeDigest(route)) {
        issue("conflicting_warehouse_route", id, "Different physical pools supplied conflicting rules for the same warehouse market.");
      } else requestedRoutes.set(id, route);
      const existing = existingRoutes.get(id);
      if (existing && routeDigest(existing) !== routeDigest(route)) {
        routeConflicts.set(id, existing);
        issue("conflicting_existing_route", id, "The verified route differs from one already connected to this warehouse.");
      }
    }
    const routeSet = migrationDigest(row.routes.map(input => ({
      marketId: input.marketId, priority: input.priority, districts: [...input.districts].sort(), methods: [...input.methods].sort(),
    })).sort((a, b) => a.marketId.localeCompare(b.marketId, "en")));
    const previousSet = routeSets.get(row.locationId);
    if (previousSet && previousSet !== routeSet) {
      issue("inconsistent_warehouse_routes", row.locationId, "Every pool in a shared warehouse must declare the same complete route set.");
    }
    routeSets.set(row.locationId, routeSet);
    for (const existing of routes) {
      if (existing.active && existing.locationId === row.locationId && !marketsWithRoute.has(existing.marketId)) {
        const id = routeKey(existing);
        routeConflicts.set(id, existing);
        issue("unverified_existing_route", id, "An active warehouse route is missing from the verified route set.");
      }
    }

    const free = row.onHand - row.reserved - row.allocated;
    const legacyAmounts: number[] = [];
    let countedRepresentations = 0;
    for (const source of row.legacySources) {
      const id = sourceBalanceKey(row.variantId, source);
      const legacy = sourceRows.get(id);
      if (consumed.has(id)) issue("duplicate_stock_source", id, "One legacy balance was assigned more than once.");
      consumed.set(id, poolKey);
      if (!legacy) {
        issue("missing_legacy_balance", id, "A physical pool references a missing or out-of-scope legacy balance.");
        continue;
      }

      const sourceWarehouse = source.kind === "location" ? warehouses.get(source.locationId) : undefined;
      const sourceOwnerId = source.kind === "shared" ? variant?.product.marketplaceShopId : sourceWarehouse?.shopId;
      if ((sourceOwnerId ?? storeShop.id) !== row.ownerId || (source.kind === "location" && !sourceWarehouse)) {
        issue("stock_owner_mismatch", id, "The legacy balance belongs to another inventory owner or an unresolved source warehouse.");
      }
      if (sourceWarehouse?.active && sourceWarehouse.marketId && !marketsWithRoute.has(sourceWarehouse.marketId)) {
        issue("unmapped_legacy_warehouse_market", id, "This named balance has an active legacy market without a verified target route.");
      }

      legacyAmounts.push(legacy.available);
      if (source.kind === "shared" && source.retired) {
        if (legacy.available !== 0 || !row.legacySources.some(item => item.kind === "location")) {
          issue("unverified_retired_balance", id, "Only a zero shared balance paired with named warehouse evidence can be marked retired.");
        }
        continue;
      }
      countedRepresentations += 1;
      if (legacy.available !== free) {
        issue("conflicting_stock_count", id, "The legacy available count conflicts with verified on-hand less reserved and allocated units.");
      }
    }
    if (!countedRepresentations || free < 0) issue("invalid_pool_balance", poolKey, "Supply an authoritative balance and reconcile nonnegative free units.");
    if (row.reserved || row.allocated) {
      issue("undrained_stock", poolKey, "Preserve the current reservations and allocations until their original provenance is mapped or drained.");
    }
    stockReport.push({ variantId: row.variantId, ownerId: row.ownerId, locationId: row.locationId, onHand: row.onHand,
      reserved: row.reserved, allocated: row.allocated, available: free, countedRepresentations,
      duplicateRepresentations: Math.max(0, countedRepresentations - 1), legacyAmounts });
    poolPlans.push({ ...row, id: stableId("pool", row.variantId, row.ownerId, row.locationId) });
  }

  for (const id of sourceRows.keys()) if (!consumed.has(id)) {
    issue("unmapped_stock", id, "This legacy balance lacks a verified physical owner and warehouse mapping.");
  }
  for (const legacy of data.shared) {
    if (legacy.available <= 0) continue;
    const id = sourceBalanceKey(legacy.variantId, { kind: "shared", retired: false });
    if (data.named.some(row => row.variantId === legacy.variantId && row.available > 0 &&
      consumed.get(sourceBalanceKey(row.variantId, { kind: "location", locationId: row.locationId })) !== consumed.get(id))) {
      issue("shared_stock_overlap", id, "A positive shared balance overlaps named stock. Establish which rows mirror the same physical units first.");
    }
  }
  for (const actual of risk.quantities) {
    const expected = poolPlans.filter(row => row.variantId === actual.variantId)
      .reduce((total, row) => ({ reserved: total.reserved + row.reserved, allocated: total.allocated + row.allocated }),
        { reserved: 0, allocated: 0 });
    if (actual.reserved !== expected.reserved || actual.allocated !== expected.allocated) {
      issue("allocation_count_mismatch", actual.variantId, "The verified reserved and allocated totals differ from active checkout and order evidence.");
    }
  }

  const prices = new Map<string, { marketId: MarketId; currency: string; offers: number; regularMinor: number; configuredSaleMinor: number }>();
  for (const row of data.offers) {
    const key = mappingTargetId(row.marketId, row.currency);
    const current = prices.get(key) ?? { marketId: row.marketId, currency: row.currency, offers: 0, regularMinor: 0, configuredSaleMinor: 0 };
    current.offers += 1;
    current.regularMinor += row.amountMinor;
    current.configuredSaleMinor += row.amountMinor - (row.discountMinor ?? 0);
    prices.set(key, current);
  }
  const routePlans = [...requestedRoutes.values()].sort((a, b) => routeKey(a).localeCompare(routeKey(b), "en"));
  return {
    // An equivalent route can already have been installed by another product batch.
    source: { ...data, active: risk.source, conflictingRoutes: [...routeConflicts.values()] },
    issues,
    offers: offerPlans,
    pools: poolPlans,
    routes: routePlans,
    mappings: commerceMappings(offerPlans, poolPlans, routePlans),
    reconciliation: { prices: [...prices.values()], stock: stockReport, outstanding: risk.quantities },
  };
}

export async function applyCommerce(tx: Prisma.TransactionClient, plan: CommercePlan): Promise<MigrationMapping[]> {
  if (plan.issues.length) throw new Error("Resolve critical commerce migration issues before applying.");
  await lockVariantInventory(tx, [...plan.offers.map(row => row.source.variantId), ...plan.pools.map(row => row.variantId)]);

  for (const row of plan.offers) {
    const { variantId, marketId } = row.source;
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { optionSignature: true, product: { select: { foundation: true } } } });
    if (!variant?.product.foundation || variant.optionSignature === null) throw new Error("Offer migration requires a normalized physical variant.");
    const current = await tx.marketOffer.findUnique({ where: { variantId_marketId: { variantId, marketId } } });
    if (migrationDigest(current) !== migrationDigest(row.source)) throw new Error("Legacy market terms changed before attachment.");
    await tx.marketOfferIdentity.create({ data: { id: row.id, variantId, marketId, sellerId: row.sellerId } });
    const attached = await tx.marketOffer.update({ where: { variantId_marketId: { variantId, marketId } }, data: { offerId: row.id } });
    if (migrationDigest({ ...attached, offerId: null }) !== migrationDigest(row.source)) {
      throw new Error("Price, publication or promotion terms changed during attachment.");
    }
  }

  for (const route of plan.routes) {
    const { locationId, marketId } = route;
    const current = await tx.dispatchLocationMarket.upsert({
      where: { locationId_marketId: { locationId, marketId } }, create: route, update: {},
    });
    if (routeDigest(current) !== routeDigest(route)) throw new Error("The warehouse route changed before migration.");
  }

  for (const row of plan.pools) {
    const { id, variantId, ownerId, locationId } = row;
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { optionSignature: true, product: { select: { foundation: true } } } });
    if (!variant?.product.foundation || variant.optionSignature === null) throw new Error("Stock migration requires a normalized physical variant.");
    await tx.inventoryPool.create({ data: { id, variantId, ownerId, locationId } });
    if (row.onHand > 0) await applyInventoryMovement(tx, {
      poolId: id, kind: "RECEIPT", quantity: row.onHand,
      idempotencyKey: `${migrationVersion}:opening`, reason: `Legacy opening balance. Evidence ${row.evidence}`,
      reference: stockPoolKey(row),
    });
    await tx.variant.update({ where: { id: variantId }, data: { managedInventory: true } });
  }
  return plan.mappings;
}
