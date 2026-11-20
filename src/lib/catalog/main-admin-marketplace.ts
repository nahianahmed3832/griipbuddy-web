import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration, marketContext, type MarketConfiguration } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { applyMarketplaceCommand, MarketplaceError } from "../marketplace/write.ts";
import { firstPartyStoreMode, marketplaceMode, orderIntakeOpen } from "../release-config.ts";
import { getMarketSettings, pauseMarketCheckout, saveDeliveryZone, saveMarketPolicy } from "../staff/market-settings.ts";
import { mainAdminOrderCommandInput, mainAdminOrderReads, readMainAdminOrders, runMainAdminOrderCommand } from "../staff/main-admin-orders.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";

const sellerId = z.string().uuid();
const revision = z.int().min(0).nullable();

export const mainAdminMarketplaceInput = z.union([
  z.strictObject({ read: z.literal("marketplace-workspace"), q: z.string().trim().max(100).optional(), page: z.int().min(1).max(10000).optional() }),
  z.strictObject({ action: z.literal("marketplace.seller.publish"), input: z.strictObject({ sellerId, published: z.boolean() }) }),
  z.strictObject({ action: z.literal("marketplace.seller.grant"), input: z.strictObject({ sellerId, status: z.enum(["APPROVED", "DENIED"]) }) }),
  z.strictObject({ action: z.literal("marketplace.policy.pause"), input: z.strictObject({}) }),
  z.strictObject({ action: z.literal("marketplace.policy.save"), input: z.strictObject({
    revision, enabled: z.boolean(), codEnabled: z.boolean(), taxBasisPoints: z.int().min(0).max(10000).nullable(), taxLabel: z.string().max(80),
  }) }),
  z.strictObject({ action: z.literal("marketplace.delivery.save"), input: z.strictObject({
    revision, district: z.string().max(40), districtLabel: z.string().max(80), method: z.string().max(40), label: z.string().max(100),
    guidance: z.string().max(500), chargeMinor: z.int().min(0).max(10000000).nullable(), enabled: z.boolean(), codEligible: z.boolean(),
  }) }),
  ...mainAdminOrderReads,
  mainAdminOrderCommandInput,
]);

type Operation = z.infer<typeof mainAdminMarketplaceInput>;
type Read = Extract<Operation, { read: "marketplace-workspace" }>;
const pageSize = 20;

function canConfigureCheckout(market: MarketConfiguration) {
  return market.checkoutAuthority === "native" && market.delivery.coverage === "checkout-policy";
}

async function workspace(actorId: string, marketId: MarketId, request: Read) {
  const db = getDb();
  const market = marketConfiguration(marketId);
  const search = request.q;
  const text = search ? { contains: search, mode: "insensitive" as const } : undefined;
  const where = { id: { not: storeShop.id }, ...(text ? { OR: [{ name: text }, { slug: text }] } : {}) };
  const [total, checkout] = await Promise.all([db.marketplaceShop.count({ where }), getMarketSettings(actorId, marketId)]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(request.page ?? 1, pageCount);
  const shops = await db.marketplaceShop.findMany({ where, skip: (page - 1) * pageSize, take: pageSize,
    orderBy: [{ name: "asc" }, { id: "asc" }], select: {
      id: true, name: true, slug: true, published: true,
      marketGrants: { where: { marketId }, select: { status: true } },
      listings: { where: { variants: { some: { offers: { some: { marketId, currency: market.currency } } } } },
        orderBy: [{ addedOn: "desc" }, { id: "asc" }], take: 8, select: { id: true, name: true, publication: true } },
    } });
  return {
    market: { ...marketContext(market), name: market.name, locale: market.defaultLocale,
      timeZone: market.timeZone, checkoutAuthority: market.checkoutAuthority,
      payments: market.payments.filter(payment => payment.evidence === "sandbox").map(({ method, enabled }) => ({ method, enabled })),
      deliveryCoverage: market.delivery.coverage, orderIntake: orderIntakeOpen() },
    thirdPartyEnabled: !firstPartyStoreMode(), canConfigureCheckout: canConfigureCheckout(market), page, pageCount, total,
    sellers: shops.map(({ marketGrants, ...shop }) => ({ ...shop, grantStatus: marketGrants[0]?.status ?? null })),
    checkout: checkout && { enabled: checkout.enabled, codEnabled: checkout.codEnabled, revision: checkout.revision,
      taxBasisPoints: checkout.taxBasisPoints, taxLabel: checkout.taxLabel, deliveryZones: checkout.deliveryZones },
  };
}

export async function mainAdminMarketplace(actorId: string, marketId: MarketId, operation: Operation) {
  if (!marketplaceMode()) throw new CatalogWriteError("not_found", "Marketplace management is unavailable.");
  if ("read" in operation) return operation.read === "marketplace-workspace" ? workspace(actorId, marketId, operation)
    : readMainAdminOrders(actorId, true, marketId, operation, true);
  const { action, input } = operation;
  if (action === "marketplace.seller.publish" || action === "marketplace.seller.grant") {
    if (firstPartyStoreMode()) throw new CatalogWriteError("forbidden", "Third-party seller management is paused for this release.");
    const shop = input.sellerId;
    const seller = await getDb().marketplaceShop.findFirst({ where: { AND: [{ id: shop }, { id: { not: storeShop.id } }],
      ...(action === "marketplace.seller.grant" ? { marketGrants: { some: { marketId } } } : {}) }, select: { id: true } });
    if (!seller) throw new CatalogWriteError("not_found", "This seller or market request could not be found.");
    try {
      return await applyMarketplaceCommand(action === "marketplace.seller.publish" ? { action: "staff-shop", shop, published: input.published }
        : { action: "staff-market-grant", shop, marketId, status: input.status }, { staffOwner: true, staffActorId: actorId, marketId });
    } catch (error) {
      if (error instanceof MarketplaceError) throw new CatalogWriteError(error.status === 404 ? "not_found"
        : error.status === 403 ? "forbidden" : "invalid_input", error.message);
      throw error;
    }
  }
  if (action !== "marketplace.policy.save" && action !== "marketplace.policy.pause" && action !== "marketplace.delivery.save") {
    return runMainAdminOrderCommand(actorId, marketId, action, input);
  }
  if (!canConfigureCheckout(marketConfiguration(marketId))) {
    throw new CatalogWriteError("forbidden", "This market uses provider-managed checkout or delivery settings.");
  }
  if (action === "marketplace.policy.save") await saveMarketPolicy(actorId, { ...input, marketId });
  else if (action === "marketplace.delivery.save") await saveDeliveryZone(actorId, { ...input, marketId });
  else await pauseMarketCheckout(actorId, marketId);
  return { saved: true };
}
