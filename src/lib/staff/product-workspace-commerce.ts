import { z } from "zod";
import { markets, marketIds, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { validVariantId } from "../cart/model.ts";
import { nativeSourceSystem } from "../catalog-migration/contracts.ts";
import { connectedSellerVisibility, type CommercialActor } from "../commerce/commercial-access.ts";
import { legacyLocationId } from "../commerce/location-inventory.ts";
import {
  compensateInventoryMovement, dispatchInventoryTransfer, initializeInventoryPool, inventoryTransferView, receiveInventoryTransfer,
  recordStockMovement, saveWarehouseService, setInventoryThreshold, transferStock,
} from "../commerce/physical-inventory.ts";
import { bindCommerceScope, commerceReferenceFor } from "../commerce/service-contract.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable, marketConfiguration, marketIdInput } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { firstPartyStoreMode, marketplaceMode } from "../release-config.ts";
import { productIdField } from "./catalog-input.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

const locationFields = {
  id: true, name: true, marketId: true, shopId: true, active: true, priority: true,
  shop: { select: { name: true } },
  marketServices: {
    orderBy: { marketId: "asc" },
    select: { marketId: true, active: true, priority: true, districts: true, methods: true },
  },
} as const satisfies Prisma.DispatchLocationSelect;
type WorkspaceLocation = Prisma.DispatchLocationGetPayload<{ select: typeof locationFields }>;

function assignedSellerOffer(sellerId: string, marketIds: MarketId[]): Prisma.MarketOfferWhereInput {
  return { marketId: { in: marketIds }, identity: { sellerId, retiredAt: null } };
}

export function sellerConnectedProductScope(shopId: string, marketIds: MarketId[]): Prisma.ProductWhereInput {
  return { foundation: true, OR: [
    { marketplaceShopId: shopId },
    { variants: { some: { offers: { some: assignedSellerOffer(shopId, marketIds) } } } },
  ] };
}

async function workspaceAccess(db: DbReader, actor: CommercialActor) {
  if (actor.kind === "staff") {
    const staff = await db.staffAccess.findUnique({
      where: { userId: actor.id }, select: {
        active: true, role: true, marketGrants: { where: { commercial: true }, select: { marketId: true } },
      },
    });
    if (!staff?.active) return null;
    const central = staff.role === "OWNER";
    return { central, shopId: null, marketIds: central ? marketIds : staff.marketGrants.map(grant => grant.marketId) };
  }
  if (!marketplaceMode() || firstPartyStoreMode()) return null;
  const shop = await db.marketplaceShop.findUnique({
    where: { ownerId: actor.id }, select: {
      id: true, published: true, marketGrants: { where: { status: "APPROVED" }, select: { marketId: true } },
    },
  });
  return shop ? { central: false, shopId: shop.id, marketIds: shop.published ? shop.marketGrants.map(grant => grant.marketId) : [] } : null;
}

function workspaceLocation(location: WorkspaceLocation, allowed: readonly MarketId[], central: boolean, current: MarketId) {
  const { name, active, priority, marketId, shopId, shop, marketServices } = location;
  const route = marketServices.find(service => service.marketId === current);
  const servingMarkets = marketServices.filter(service => service.active).map(service => service.marketId);
  const inScope = marketId === current || servingMarkets.includes(current);
  const canManage = central || Boolean(marketId && allowed.includes(marketId) && servingMarkets.every(market => allowed.includes(market)));
  return {
    id: location.id, name, ownerId: shopId ?? storeShop.id, ownerName: shop?.name ?? storeShop.name, active, priority,
    inScope, canManage, servingMarkets: servingMarkets.filter(market => allowed.includes(market)),
    route: route ? { active: route.active, priority: route.priority, districts: route.districts, methods: route.methods } : null,
  };
}

export async function readProductWorkspaceCommerce(actor: CommercialActor, productId: string, marketId: MarketId) {
  return getDb().$transaction(async db => {
    const access = await workspaceAccess(db, actor);
    if (!access) return null;
    const marketOptions = access.marketIds.filter(isMarketSelectable).map(id => ({ id, name: markets[id].name }));
    const allowed = marketOptions.map(market => market.id);
    const productScope = { id: productId, foundation: true,
      ...(access.shopId && sellerConnectedProductScope(access.shopId, allowed)),
    };
    if (!allowed.includes(marketId)) {
      const exists = await db.product.findFirst({ where: productScope, select: { id: true } });
      return exists ? { marketOptions, data: null } : null;
    }
    const product = await db.product.findFirst({ where: {
      ...productScope, ...(access.shopId && sellerConnectedProductScope(access.shopId, [marketId])),
    }, select: {
      id: true, name: true, publication: true, marketplaceShopId: true,
      variants: { orderBy: [{ position: "asc" }, { id: "asc" }], select: {
        id: true, label: true, sku: true, active: true, archivedAt: true, managedInventory: true,
        inventory: { select: { variantId: true } },
        _count: { select: { locationInventory: true, offers: { where: { offerId: null } } } },
        offers: { where: { marketId }, select: {
          offerId: true, revision: true, currency: true, amountMinor: true, discountMinor: true,
          discountStartsAt: true, discountEndsAt: true, publication: true, eligible: true,
          identity: { select: { sellerId: true, seller: { select: { name: true } } } },
        } },
      } },
    } });
    if (!product) {
      const exists = await db.product.findFirst({ where: productScope, select: { id: true } });
      return exists ? { marketOptions, data: null } : null;
    }
    const sharedWithSeller = access.shopId && product.marketplaceShopId !== access.shopId;
    const accessibleVariants = sharedWithSeller ?
      product.variants.filter(variant => variant.offers.some(offer => offer.identity?.sellerId === access.shopId)) : product.variants;

    const [approvedSellers, locations, pools] = await Promise.all([
      db.marketplaceShop.findMany({
        where: { AND: [connectedSellerVisibility(marketId), ...(access.shopId ? [{ id: access.shopId }] : [])] },
        select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      db.dispatchLocation.findMany({ where: {
        id: { not: legacyLocationId }, marketId: { not: null }, active: true,
        ...(access.shopId && { shopId: access.shopId }),
        ...(access.central ? {} : { marketId: { in: allowed } }),
      }, orderBy: [{ name: "asc" }, { id: "asc" }], select: locationFields }),
      db.inventoryPool.findMany({ where: {
        variantId: { in: accessibleVariants.map(variant => variant.id) }, ...(access.shopId && { ownerId: access.shopId }),
        location: { ...(access.shopId && { shopId: access.shopId }),
          OR: [{ marketId }, { marketServices: { some: { marketId, active: true } } }] },
      }, orderBy: [{ variantId: "asc" }, { locationId: "asc" }, { ownerId: "asc" }], select: {
        id: true, variantId: true, ownerId: true, onHand: true, reserved: true, lowStockThreshold: true, updatedAt: true,
        location: { select: locationFields },
        owner: { select: { name: true } },
      } }),
    ]);
    const stockScope = bindCommerceScope({ authority: nativeSourceSystem, marketId, currency: markets[marketId].currency });
    const warehouseChoices = locations.map(location => ({
      ...workspaceLocation(location, allowed, access.central, marketId), reference: commerceReferenceFor(stockScope, "warehouse", location.id),
    })).filter(warehouse => warehouse.canManage);
    const scopedPools = pools.flatMap(({ location, owner, ...pool }) => {
      const warehouse = workspaceLocation(location, allowed, access.central, marketId);
      if (!warehouse.canManage) return [];
      const available = pool.onHand - pool.reserved;
      return [{
        ...pool, updatedAt: pool.updatedAt.toISOString(), available, unavailable: pool.reserved,
        isLowStock: pool.lowStockThreshold !== null && available <= pool.lowStockThreshold,
        reference: commerceReferenceFor(stockScope, "stock_pool", pool.id),
        variantReference: commerceReferenceFor(stockScope, "variant", pool.variantId),
        warehouse: { ...warehouse, reference: commerceReferenceFor(stockScope, "warehouse", warehouse.id) },
        ownerName: owner.name, legacyOwnerMismatch: warehouse.ownerId !== pool.ownerId,
      }];
    });
    const poolIds = scopedPools.map(pool => pool.id);
    const transferScope = { fromPoolId: { in: poolIds }, toPoolId: { in: poolIds }, marketId: { in: allowed } };
    const [movements, allocations, transfers, inbound, outbound] = poolIds.length ? await Promise.all([
      db.inventoryMovement.findMany({
        where: { poolId: { in: poolIds } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
        select: { id: true, poolId: true, kind: true, quantity: true, createdAt: true, reason: true, reference: true,
          reversesMovementId: true, relatedPoolId: true, actorKind: true, ...(actor.kind === "staff" && { actorId: true }),
        },
      }),
      db.inventoryAllocation.findMany({
        where: { poolId: { in: poolIds }, reservation: { marketId: { in: allowed } } },
        orderBy: [{ reservation: { createdAt: "desc" } }, { id: "desc" }], take: 30,
        select: { id: true, poolId: true, quantity: true, dispatched: true, returned: true,
          ...(actor.kind === "staff" && { reservationId: true }),
          reservation: { select: { marketId: true, state: true, expiresAt: true, createdAt: true } },
        },
      }),
      db.inventoryTransfer.findMany({ where: transferScope, orderBy: [{ dispatchedAt: "desc" }, { id: "desc" }], take: 30 }),
      db.inventoryTransfer.groupBy({
        by: ["toPoolId"], where: { toPoolId: { in: poolIds }, marketId: { in: allowed }, receivedAt: null }, _sum: { quantity: true },
      }),
      db.inventoryTransfer.groupBy({
        by: ["fromPoolId"], where: { fromPoolId: { in: poolIds }, marketId: { in: allowed }, receivedAt: null }, _sum: { quantity: true },
      }),
    ]) : [[], [], [], [], []];
    const incoming = new Map(inbound.map(row => [row.toPoolId, row._sum.quantity ?? 0]));
    const outgoing = new Map(outbound.map(row => [row.fromPoolId, row._sum.quantity ?? 0]));

    const defaultSellerId = product.marketplaceShopId ?? storeShop.id;
    const config = marketConfiguration(marketId);
    const variants = accessibleVariants.map(variant => {
      const offer = variant.offers[0];
      const sellerId = offer?.identity?.sellerId ?? defaultSellerId;
      const assignedToSeller = !access.shopId || sellerId === access.shopId;
      return {
        id: variant.id, sku: variant.sku, label: variant.label, active: variant.active && !variant.archivedAt,
        managedInventory: variant.managedInventory,
        legacyInventory: Boolean(variant.inventory || variant._count.locationInventory || variant._count.offers),
        canEditOffer: product.publication !== "ARCHIVED" && assignedToSeller && (offer ? Boolean(offer.offerId) : Boolean(access.central ? approvedSellers.length :
          approvedSellers.some(seller => seller.id === sellerId))),
        sellerId: assignedToSeller ? sellerId : null,
        offer: offer && assignedToSeller ? {
          id: offer.offerId, revision: offer.revision, currency: offer.currency, amountMinor: offer.amountMinor,
          salePriceMinor: offer.discountMinor === null ? null : offer.amountMinor - offer.discountMinor,
          saleStartsAt: offer.discountStartsAt?.toISOString() ?? null, saleEndsAt: offer.discountEndsAt?.toISOString() ?? null,
          publication: offer.publication, eligible: offer.eligible, sellerName: offer.identity?.seller.name ?? null,
        } : null,
      };
    });
    return { marketOptions, data: {
      productId: product.id, publication: product.publication, central: access.central, actorKind: actor.kind,
      market: { ...markets[marketId], locale: config.defaultLocale, status: config.status },
      authority: nativeSourceSystem, sellers: approvedSellers, variants, warehouses: warehouseChoices,
      pools: scopedPools.map(pool => ({ ...pool, inTransitIn: incoming.get(pool.id) ?? 0, inTransitOut: outgoing.get(pool.id) ?? 0 })),
      transfers: transfers.map(inventoryTransferView),
      hasRestrictedPools: scopedPools.length < pools.length,
      movements: movements.map(({ createdAt, relatedPoolId, ...movement }) => ({ ...movement,
        relatedPoolId: relatedPoolId && poolIds.includes(relatedPoolId) ? relatedPoolId : null, createdAt: createdAt.toISOString(),
      })),
      allocations: allocations.map(({ reservation, ...allocation }) => ({ ...allocation, ...reservation,
        expiresAt: reservation.expiresAt.toISOString(), createdAt: reservation.createdAt.toISOString(),
      })),
    } };
  }, { isolationLevel: "RepeatableRead" });
}

export type ProductWorkspaceCommerce = NonNullable<Awaited<ReturnType<typeof readProductWorkspaceCommerce>>>;
export type ProductWorkspaceCommerceData = NonNullable<ProductWorkspaceCommerce["data"]>;

const stockContext = { productId: productIdField, marketId: marketIdInput };
const warehouseId = z.string().min(1).max(96);
const timestamp = z.iso.datetime().transform(value => new Date(value));
const movementInput = {
  idempotencyKey: z.string().min(1).max(120), reason: z.string().min(1).max(240), reference: z.string().min(1).max(160),
  quantity: z.int().min(-1_000_000).max(1_000_000),
};
const routing = { active: z.boolean(), priority: z.int().min(0).max(1000),
  districts: z.array(z.string().max(40)).max(100), methods: z.array(z.string().max(40)).max(30) };
export const workspaceStockCommands: ReadonlySet<string> = new Set([
  "inventory.initialize", "inventory.movement", "inventory.transfer", "inventory.route", "inventory.threshold", "inventory.compensate",
  "inventory.transfer-dispatch", "inventory.transfer-receive",
]);

export async function runWorkspaceStockCommand(actor: CommercialActor, action: string, raw: unknown) {
  if (action === "inventory.initialize") {
    const { marketId, productId, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, variantId: z.string().refine(validVariantId), locationId: warehouseId,
    }), raw);
    return initializeInventoryPool(actor, fields, { marketId, productId });
  }
  if (action === "inventory.movement") {
    const { marketId, productId, expectedUpdatedAt, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, ...movementInput, poolId: z.uuid(), kind: z.enum(["RECEIPT", "ADJUSTMENT", "DAMAGE"]), expectedUpdatedAt: timestamp,
    }), raw);
    return recordStockMovement(actor, fields, { marketId, productId, expectedUpdatedAt });
  }
  if (action === "inventory.transfer" || action === "inventory.transfer-dispatch") {
    const { marketId, productId, expectedUpdatedAt, expectedDestinationUpdatedAt, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, ...movementInput, fromPoolId: z.uuid(), toPoolId: z.uuid(),
      expectedUpdatedAt: timestamp, expectedDestinationUpdatedAt: timestamp,
    }), raw);
    const move = action === "inventory.transfer-dispatch" ? dispatchInventoryTransfer : transferStock;
    return move(actor, fields, { marketId, productId, expectedUpdatedAt, expectedDestinationUpdatedAt });
  }
  if (action === "inventory.transfer-receive") {
    const { marketId, productId, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, transferId: z.uuid(), idempotencyKey: movementInput.idempotencyKey,
    }), raw);
    return receiveInventoryTransfer(actor, fields, { marketId, productId });
  }
  if (action === "inventory.threshold") {
    const { marketId, productId, expectedUpdatedAt, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, poolId: z.uuid(), threshold: z.int().min(0).max(1_000_000).nullable(), expectedUpdatedAt: timestamp,
    }), raw);
    return setInventoryThreshold(actor, fields, { marketId, productId, expectedUpdatedAt });
  }
  if (action === "inventory.compensate") {
    const { marketId, productId, expectedUpdatedAt, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, movementId: z.uuid(), idempotencyKey: movementInput.idempotencyKey,
      reason: movementInput.reason, reference: movementInput.reference, expectedUpdatedAt: timestamp,
    }), raw);
    return compensateInventoryMovement(actor, fields, { marketId, productId, expectedUpdatedAt });
  }
  if (action === "inventory.route") {
    const { productId, expected, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, ...routing, locationId: warehouseId, expected: z.strictObject(routing).nullable(),
    }), raw);
    const db = getDb();
    const access = await workspaceAccess(db, actor);
    const found = access?.marketIds.includes(fields.marketId) && await db.product.findFirst({ where: {
      id: productId, foundation: true,
      ...(access.shopId && sellerConnectedProductScope(access.shopId, [fields.marketId])),
    }, select: { id: true } });
    if (!found) throw new CatalogWriteError("forbidden", "The product or market is outside your inventory scope.");
    return saveWarehouseService(actor, fields, expected);
  }
  throw new CatalogWriteError("invalid_input", "Choose an inventory command.");
}
