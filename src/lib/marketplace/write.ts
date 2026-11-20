import { randomUUID } from "node:crypto";
import { getDb, type DbReader } from "../db/client.ts";
import { storeShop } from "./constants.ts";
import type { MarketplaceCommand } from "./commands.ts";
import { markets, marketList, type MarketId } from "../../config/markets.ts";
import { firstPartyStoreMode, marketplaceMode } from "../release-config.ts";
import { isMarketSelectable, selectedMarketId } from "../market-config.ts";
import { merchantProductEligibility, sellerVisibility } from "./market-grants.ts";
import { lockProductEdits } from "../staff/operations.ts";
import { lockTaxonomy, validPrimaryCategory } from "../staff/taxonomy-write.ts";
import { lockVariantInventory } from "../commerce/location-inventory.ts";
import { lockVariantQuoteRows } from "../commerce/orders.ts";
import { updateVariantWatch, VariantWatchError } from "./variant-watches.ts";

export class MarketplaceError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function requireRecord<T>(value: T | null | undefined, message = "We couldn't find this record."): T {
  if (value === null || value === undefined) throw new MarketplaceError(message, 404);
  return value;
}

async function visibleProduct(db: DbReader, id: string, marketId: MarketId) {
  return requireRecord(await db.product.findFirst({ where: {
    id, active: true, publication: "ACTIVE", ...merchantProductEligibility(marketId),
    variants: { some: { active: true, managedInventory: false,
      offers: { some: { marketId, eligible: true, currency: markets[marketId].currency, offerId: null } } } },
  }, select: { id: true } }), "This listing is unavailable.");
}

async function lockShop(db: DbReader, shopId: string) {
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "MarketplaceShop" WHERE id = ${shopId}::uuid FOR UPDATE`;
  requireRecord(rows[0]);
}

async function draftListing(shopperId: string, marketId: MarketId, input: Extract<MarketplaceCommand, { action: "draft-listing" }>) {
  const db = getDb();
  return db.$transaction(async tx => {
    await lockTaxonomy(tx);
    const shop = requireRecord(await tx.marketplaceShop.findUnique({ where: { ownerId: shopperId }, select: { id: true, slug: true } }));
    if (input.id) {
      await lockProductEdits(tx, input.id);
      const variants = await tx.variant.findMany({
        where: { product: { id: input.id, marketplaceShopId: shop.id, publication: "DRAFT", foundation: false } },
        select: { id: true },
      });
      await lockVariantInventory(tx, variants.map(variant => variant.id));
    }
    await lockShop(tx, shop.id);
    const prices = input.marketPrices ?? { [marketId]: input.amount };
    const offers = marketList.flatMap(({ id: marketId, currency }) => {
      const amountMinor = prices?.[marketId];
      return amountMinor === undefined ? [] : [{ marketId, currency, amountMinor, eligible: true }];
    });
    if (!offers.length) throw new MarketplaceError("Set a price for at least one approved market.");
    const approved = await tx.marketplaceShopMarket.findMany({ where: { shopId: shop.id, status: "APPROVED" } });
    if (offers.some(offer => !isMarketSelectable(offer.marketId) || !approved.some(grant => grant.marketId === offer.marketId))) {
      throw new MarketplaceError("Your shop needs approval to sell in each selected market.", 403);
    }
    if (!await validPrimaryCategory(tx, input.department, input.id ?? "")) {
      throw new MarketplaceError("Choose an active primary category distinct from the additional categories.");
    }
    const fields = {
      name: input.name, description: input.description, departmentId: input.department,
      keywords: [...new Set(input.tags.split(",").map(tag => tag.trim().slice(0, 60)).filter(Boolean))].slice(0, 13),
      ...(input.personalization !== undefined && {
        personalizationPrompt: input.personalization?.prompt ?? null,
        personalizationRequired: input.personalization?.required ?? false,
      }),
    };
    const sku = `M${shop.id.replaceAll("-", "").slice(0, 10)}-${input.sku}`.toUpperCase();
    if (input.id) {
      const where = { id: input.id, marketplaceShopId: shop.id, publication: "DRAFT" as const, foundation: false };
      requireRecord((await tx.product.updateMany({ where, data: { ...fields, revision: { increment: 1 } } })).count || null);
      const variant = requireRecord(await tx.variant.findFirst({ where: { productId: input.id },
        select: { id: true, locationInventory: { take: 1, select: { locationId: true } } },
      }));
      await tx.variant.update({ where: { id: variant.id }, data: { sku } });
      if (!variant.locationInventory.length) await tx.inventory.update({ where: { variantId: variant.id }, data: { available: input.quantity } });
      await tx.marketOffer.updateMany({
        where: { variantId: variant.id, marketId: { notIn: offers.map(offer => offer.marketId) } }, data: { eligible: false },
      });
      for (const offer of offers) {
        await tx.marketOffer.upsert({ where: { variantId_marketId: { variantId: variant.id, marketId: offer.marketId } },
          create: { ...offer, variantId: variant.id }, update: offer });
      }
      return { id: input.id };
    }
    const count = await tx.product.count({ where: { marketplaceShopId: shop.id } });
    if (count >= 30) throw new MarketplaceError("This preview allows 30 listings per shop.");
    const id = randomUUID();
    return tx.product.create({ data: { id: `p-${id}`, slug: `${shop.slug}-${id}`, ...fields, marketplaceShopId: shop.id,
      specifications: [], position: 10_000, addedOn: new Date(), publication: "DRAFT", demo: true,
      variants: { create: { id: `v-${id}`, sku, options: {}, label: "Standard", position: 1,
        inventory: { create: { available: input.quantity } },
        offers: { create: offers } } },
    }, select: { id: true } });
  });
}

async function setSellerLocationStock(shopperId: string, input: Extract<MarketplaceCommand, { action: "seller-location-stock" }>) {
  if (!marketplaceMode() || firstPartyStoreMode()) throw new MarketplaceError("Location stock is unavailable.", 404);
  return getDb().$transaction(async tx => {
    const location = requireRecord(await tx.dispatchLocation.findFirst({
      where: { id: input.locationId, active: true, shop: { ownerId: shopperId } }, select: { marketId: true, shopId: true },
    }), "This stock location is unavailable.");
    if (!location.marketId || !location.shopId) throw new MarketplaceError("This stock location is unavailable.", 404);
    await lockVariantQuoteRows(tx, location.marketId, [input.variantId]);
    const where = { variantId: input.variantId, locationId: input.locationId,
      variant: { active: true, managedInventory: false, product: { marketplaceShopId: location.shopId, publication: { not: "ARCHIVED" as const } } },
      location: { active: true, marketId: location.marketId, shop: {
        id: location.shopId, ownerId: shopperId, marketGrants: { some: { marketId: location.marketId, status: "APPROVED" as const } },
      } },
    };
    const stock = requireRecord(await tx.locationInventory.findFirst({ where, select: { available: true } }), "This stock assignment is unavailable.");
    if (stock.available !== input.expectedAvailable) throw new MarketplaceError("This stock count changed. Refresh the listing and try again.", 409);
    if (stock.available === input.available) return {};
    await tx.locationInventory.update({ where: { variantId_locationId: { variantId: input.variantId, locationId: input.locationId } },
      data: { available: input.available },
    });
    await tx.auditEvent.create({ data: { action: "STOCK_CHANGED", target: input.variantId,
      changes: { shopperId, shopId: location.shopId, locationId: input.locationId, before: stock.available, after: input.available },
    } });
    return {};
  });
}

export async function applyMarketplaceCommand(command: MarketplaceCommand, viewer: {
  shopperId?: string; staffOwner?: boolean; staffActorId?: string; guestKey?: string | null; marketId?: MarketId;
}) {
  const db = getDb();
  const marketId = selectedMarketId(viewer.marketId);
  if (command.action === "staff-market-grant") {
    if (!marketplaceMode() || firstPartyStoreMode() || !isMarketSelectable(command.marketId)) throw new MarketplaceError("Market approvals are unavailable.", 404);
    if (!viewer.staffOwner) throw new MarketplaceError("Owner access is required.", 403);
    if (command.shop === storeShop.id) throw new MarketplaceError("The GriipBuddy shop uses the store catalog.");
    return db.$transaction(async tx => {
      await lockShop(tx, command.shop);
      const key = { shopId: command.shop, marketId: command.marketId };
      const previous = await tx.marketplaceShopMarket.findUnique({ where: { shopId_marketId: key } });
      if (previous?.status === command.status) return {};
      await tx.marketplaceShopMarket.upsert({ where: { shopId_marketId: key },
        create: { ...key, status: command.status }, update: { status: command.status } });
      await tx.auditEvent.create({ data: {
        actorId: viewer.staffActorId, action: "MARKETPLACE_GRANT_CHANGED", target: command.shop,
        changes: { marketId: command.marketId, previous: previous?.status ?? null, approved: command.status === "APPROVED" },
      } });
      return {};
    });
  }
  if (command.action === "staff-shop" || command.action === "staff-review") {
    if (!viewer.staffOwner) throw new MarketplaceError("Owner access is required.", 403);
    if (command.action === "staff-shop") {
      if (command.shop === storeShop.id) throw new MarketplaceError("The main store already has a public shop page.");
      await db.marketplaceShop.update({ where: { id: command.shop }, data: { published: command.published } });
    } else await db.shopperReview.update({ where: { id: command.review }, data: { visible: command.visible } });
    return {};
  }
  if (viewer.staffOwner && !viewer.shopperId && command.action !== "reply" && command.action !== "close-thread") {
    throw new MarketplaceError("Sign in as a shopper first.", 401);
  }
  const shopperId = viewer.shopperId;
  if (command.action === "reply" || command.action === "close-thread") {
    if (!shopperId && !viewer.staffOwner) throw new MarketplaceError("Sign in to open messages.", 401);
    return db.$transaction(async tx => {
      const where = { id: command.thread, OR: [
        ...(shopperId ? [{ shopperId }, { shop: { ownerId: shopperId } }] : []),
        ...(viewer.staffOwner ? [{ shopId: storeShop.id }] : []),
      ] };
      const thread = requireRecord(await tx.shopperRequest.findFirst({ where, select: { id: true, shopperId: true } }));
      const updated = await tx.shopperRequest.updateMany({ where: { ...where, closed: false },
        data: command.action === "close-thread" ? { closed: true } : { updatedAt: new Date() } });
      if (!updated.count) throw new MarketplaceError("This conversation is closed.", 409);
      if (command.action === "reply") await tx.shopperMessage.create({ data: {
        requestId: thread.id, text: command.text, fromShop: thread.shopperId !== shopperId,
      } });
      return {};
    });
  }
  if (!shopperId) throw new MarketplaceError("Sign in to continue.", 401);
  switch (command.action) {
    case "variant-watch":
      if (command.shopperId !== shopperId) throw new MarketplaceError("The signed-in account changed. Refresh the page.", 403);
      try { return await updateVariantWatch(shopperId, command); }
      catch (error) {
        if (error instanceof VariantWatchError) throw new MarketplaceError(error.message, error.status);
        throw error;
      }
    case "favorite": {
      const where = { shopperId, productId: command.product };
      if (command.selected) {
        await visibleProduct(db, command.product, marketId);
        await db.shopperFavorite.upsert({ where: { shopperId_productId: where }, create: where, update: {} });
      } else await db.shopperFavorite.deleteMany({ where });
      return {};
    }
    case "follow": {
      const where = { shopperId, shopId: command.shop };
      if (command.selected) {
        requireRecord(await db.marketplaceShop.findFirst({ where: { AND: [{ id: command.shop }, sellerVisibility(marketId)] }, select: { id: true } }));
        await db.shopperFollow.upsert({ where: { shopperId_shopId: where }, create: where, update: {} });
      } else await db.shopperFollow.deleteMany({ where });
      return {};
    }
    case "create-list":
      return db.shopperList.create({ data: { shopperId, name: command.name, registry: command.registry },
        select: { id: true, name: true, registry: true, public: true } });
    case "edit-list":
      requireRecord((await db.shopperList.updateMany({ where: { id: command.list, shopperId }, data: { name: command.name, public: command.public } })).count || null);
      return {};
    case "delete-list":
      await db.shopperList.deleteMany({ where: { id: command.list, shopperId } });
      return {};
    case "list-item": {
      const list = requireRecord(await db.shopperList.findFirst({ where: { id: command.list, shopperId }, select: { id: true } }));
      const where = { listId: list.id, productId: command.product };
      if (command.selected) {
        await visibleProduct(db, command.product, marketId);
        await db.shopperListItem.upsert({ where: { listId_productId: where }, create: where, update: {} });
      } else await db.shopperListItem.deleteMany({ where });
      return {};
    }
    case "claim-order": {
      if (!viewer.guestKey) throw new MarketplaceError("Open this order using its original checkout browser.", 403);
      const order = await db.order.updateMany({ where: { id: command.order, shopperId: null, attempt: { guestKey: viewer.guestKey } },
        data: { shopperId } });
      if (!order.count && !await db.order.findFirst({ where: { id: command.order, shopperId }, select: { id: true } })) {
        throw new MarketplaceError("This order isn't available to claim.", 404);
      }
      return {};
    }
    case "review": {
      requireRecord(await db.order.findFirst({ where: { id: command.order, shopperId, status: "PLACED", fulfillmentStatus: "DELIVERED",
        items: { some: { variant: { productId: command.product } } } }, select: { id: true } }), "Reviews require a delivered purchase.");
      const where = { orderId: command.order, productId: command.product };
      await db.shopperReview.upsert({ where: { orderId_productId: where }, create: { ...where, shopperId, stars: command.stars, text: command.text },
        update: { stars: command.stars, text: command.text, visible: false } });
      return {};
    }
    case "open-message": {
      const shop = requireRecord(await db.marketplaceShop.findFirst({
        where: { AND: [{ id: command.shop }, command.order ? {} : sellerVisibility(marketId)] },
        select: { id: true, ownerId: true },
      }));
      if (shop.ownerId === shopperId) throw new MarketplaceError("Choose a shop other than your own.");
      if (command.order) requireRecord(await db.order.findFirst({ where: { id: command.order, shopperId, items: {
        some: { OR: [{ marketplaceShopId: shop.id }, ...(shop.id === storeShop.id ? [{ marketplaceShopId: null }] : [])] },
      } }, select: { id: true } }));
      return db.shopperRequest.create({ data: { shopperId, shopId: shop.id, orderId: command.order, subject: command.subject,
        messages: { create: { text: command.text } } }, select: { id: true } });
    }
    case "create-shop":
      return db.marketplaceShop.create({ data: { ownerId: shopperId, name: command.name, slug: command.slug, about: command.about, announcement: "" }, select: { id: true } });
    case "edit-shop":
      await db.marketplaceShop.update({ where: { ownerId: shopperId }, data: { name: command.name, about: command.about, announcement: command.announcement } });
      return {};
    case "draft-listing":
      return draftListing(shopperId, marketId, command);
    case "seller-location-stock":
      return setSellerLocationStock(shopperId, command);
    case "request-market":
      if (!marketplaceMode() || firstPartyStoreMode() || !isMarketSelectable(command.marketId)) throw new MarketplaceError("Market applications are unavailable.", 404);
      return db.$transaction(async tx => {
        const shop = requireRecord(await tx.marketplaceShop.findUnique({ where: { ownerId: shopperId }, select: { id: true } }));
        await lockShop(tx, shop.id);
        const key = { shopId: shop.id, marketId: command.marketId };
        const previous = await tx.marketplaceShopMarket.findUnique({ where: { shopId_marketId: key } });
        if (previous?.status === "APPROVED" || previous?.status === "PENDING") return {};
        await tx.marketplaceShopMarket.upsert({ where: { shopId_marketId: key }, create: key,
          update: { status: "PENDING", requestedAt: new Date() } });
        return {};
      });
    case "save-address":
      return db.shopperAddress.create({ data: { shopperId, label: command.label, details: command.customer }, select: { id: true } });
    case "delete-address":
      await db.shopperAddress.deleteMany({ where: { id: command.address, shopperId } });
      return {};
  }
}
