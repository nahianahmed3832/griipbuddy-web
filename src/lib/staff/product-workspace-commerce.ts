import { z } from "zod";
import { markets, marketIds, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { validVariantId } from "../cart/model.ts";
import { connectedSellerVisibility, type CommercialActor } from "../commerce/commercial-access.ts";
import { legacyLocationId } from "../commerce/location-inventory.ts";
import { initializeInventoryPool, recordStockMovement, saveWarehouseService, transferStock } from "../commerce/physical-inventory.ts";
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
        location: { OR: [{ marketId }, { marketServices: { some: { marketId, active: true } } }] },
      }, orderBy: [{ variantId: "asc" }, { locationId: "asc" }, { ownerId: "asc" }], select: {
        id: true, variantId: true, ownerId: true, onHand: true, reserved: true, updatedAt: true,
        location: { select: locationFields },
        owner: { select: { name: true } },
      } }),
    ]);
    const warehouseChoices = locations.map(location => workspaceLocation(location, allowed, access.central, marketId))
      .filter(warehouse => warehouse.canManage);
    const scopedPools = pools.flatMap(({ location, owner, ...pool }) => {
      const warehouse = workspaceLocation(location, allowed, access.central, marketId);
      if (!warehouse.canManage) return [];
      return [{ ...pool, updatedAt: pool.updatedAt.toISOString(), available: pool.onHand - pool.reserved,
        ownerName: owner.name, warehouse, legacyOwnerMismatch: warehouse.ownerId !== pool.ownerId,
      }];
    });
    const poolIds = scopedPools.map(pool => pool.id);
    const [movements, allocations] = poolIds.length ? await Promise.all([
      db.inventoryMovement.findMany({
        where: { poolId: { in: poolIds } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
        select: { id: true, poolId: true, kind: true, quantity: true, createdAt: true },
      }),
      db.inventoryAllocation.findMany({
        where: { poolId: { in: poolIds }, reservation: { marketId: { in: allowed } } },
        orderBy: [{ reservation: { createdAt: "desc" } }, { id: "desc" }], take: 30,
        select: { id: true, poolId: true, quantity: true, dispatched: true, returned: true,
          ...(actor.kind === "staff" && { reservationId: true }),
          reservation: { select: { marketId: true, state: true, expiresAt: true, createdAt: true } },
        },
      }),
    ]) : [[], []];

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
        canEditOffer: assignedToSeller && (offer ? Boolean(offer.offerId) : Boolean(access.central ? approvedSellers.length :
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
      sellers: approvedSellers, variants, warehouses: warehouseChoices, pools: scopedPools,
      hasRestrictedPools: scopedPools.length < pools.length,
      movements: movements.map(({ createdAt, ...movement }) => ({ ...movement, createdAt: createdAt.toISOString() })),
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
  "inventory.initialize", "inventory.movement", "inventory.transfer", "inventory.route",
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
      ...stockContext, ...movementInput, poolId: z.uuid(), kind: z.enum(["RECEIPT", "ADJUSTMENT"]), expectedUpdatedAt: timestamp,
    }), raw);
    return recordStockMovement(actor, fields, { marketId, productId, expectedUpdatedAt });
  }
  if (action === "inventory.transfer") {
    const { marketId, productId, expectedUpdatedAt, expectedDestinationUpdatedAt, ...fields } = catalogWriteInput(z.strictObject({
      ...stockContext, ...movementInput, fromPoolId: z.uuid(), toPoolId: z.uuid(),
      expectedUpdatedAt: timestamp, expectedDestinationUpdatedAt: timestamp,
    }), raw);
    return transferStock(actor, fields, { marketId, productId, expectedUpdatedAt, expectedDestinationUpdatedAt });
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
