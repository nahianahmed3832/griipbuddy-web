import type { MarketId } from "../../config/markets.ts";
import { catalog, publicProductScope } from "../catalog/repository.ts";
import { productCards } from "../catalog/listing.ts";
import { getDb } from "../db/client.ts";
import { bangladeshTrackingSummary } from "../commerce/bangladesh-shipment.ts";
import { shopperParcelSummary } from "../commerce/parcel-tracking.ts";
import { storeShop } from "./constants.ts";
import { sellerVisibility } from "./market-grants.ts";

const summary = { id: true, slug: true, name: true } as const;

export async function shopperSelections(shopperId: string, marketId: MarketId) {
  const db = getDb();
  const [favorites, lists, follows] = await Promise.all([
    db.shopperFavorite.findMany({ where: { shopperId, product: publicProductScope(marketId) }, orderBy: { createdAt: "desc" }, take: 300, select: { productId: true } }),
    db.shopperList.findMany({ where: { shopperId }, orderBy: { createdAt: "asc" }, take: 50,
      select: { id: true, name: true, registry: true, public: true } }),
    db.shopperFollow.findMany({ where: { shopperId, shop: sellerVisibility(marketId) }, take: 100, select: { shop: { select: summary } } }),
  ]);
  return { favorites: favorites.map(row => row.productId), lists, shops: follows.map(row => row.shop) };
}

export async function savedList(id: string, shopperId?: string) {
  return getDb().shopperList.findFirst({ where: { id, OR: [{ public: true }, ...(shopperId ? [{ shopperId }] : [])] }, select: {
    id: true, name: true, registry: true, public: true, shopperId: true,
    items: { orderBy: { createdAt: "desc" }, take: 300, select: { productId: true } },
  } });
}

export async function cardsById(marketId: MarketId, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const products = await catalog.listProducts({ marketId, productIds: ids });
  const byId = new Map(productCards(products).map(card => [card.id, card]));
  return ids.flatMap(id => byId.get(id) ?? []);
}

export async function productReviews(productId: string, marketId: MarketId) {
  return getDb().shopperReview.findMany({ where: { productId, visible: true, order: { marketId } }, orderBy: { createdAt: "desc" }, take: 30,
    select: { id: true, stars: true, text: true, createdAt: true, shopper: { select: { name: true } } } });
}

export async function searchShops(query: string, marketId: MarketId) {
  return getDb().marketplaceShop.findMany({ where: { AND: [sellerVisibility(marketId), ...(query ? [{ OR: [
    { name: { contains: query, mode: "insensitive" as const } }, { slug: { contains: query.toLowerCase() } },
  ] }] : [])] }, orderBy: { name: "asc" }, take: 20, select: { ...summary, announcement: true, about: true } });
}

export function shopperOrders(shopperId: string | undefined, guestKey: string | null) {
  return getDb().order.findMany({ where: { OR: [
    ...(shopperId ? [{ shopperId }] : []),
    ...(guestKey ? [{ shopperId: null, attempt: { guestKey } }] : []),
  ] }, orderBy: { createdAt: "desc" }, take: 40,
  select: { id: true, reference: true, status: true, fulfillmentStatus: true, createdAt: true, totalMinor: true, marketId: true, shopperId: true,
    bangladeshShipment: bangladeshTrackingSummary, bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
    parcels: shopperParcelSummary } });
}

export function threadsFor(shopperId: string, shopId?: string) {
  return getDb().shopperRequest.findMany({ where: shopId ? { shopId } : { shopperId }, orderBy: { updatedAt: "desc" }, take: 60,
    select: { id: true, subject: true, closed: true, updatedAt: true, shop: { select: summary }, order: { select: { reference: true } } } });
}

export async function userThread(id: string, viewer: { shopperId?: string; staffOwner?: boolean }) {
  const { shopperId, staffOwner } = viewer;
  return getDb().shopperRequest.findFirst({ where: { id, OR: [
    ...(shopperId ? [{ shopperId }, { shop: { ownerId: shopperId } }] : []),
    ...(staffOwner ? [{ shopId: storeShop.id }] : []),
  ] }, select: { id: true, shopperId: true, subject: true, closed: true, order: { select: { reference: true } },
    shop: { select: { ...summary, ownerId: true } }, messages: { orderBy: { createdAt: "desc" }, take: 80,
      select: { id: true, fromShop: true, text: true, createdAt: true } } } });
}
