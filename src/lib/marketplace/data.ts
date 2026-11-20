import { defaultMarketId, type MarketId } from "../../config/markets.ts";
import { catalog } from "../catalog/repository.ts";
import { catalogVariantWhere } from "../catalog/connected-public.ts";
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
    db.shopperFavorite.findMany({ where: { shopperId, product: { variants: { some: catalogVariantWhere(marketId, true) } } }, orderBy: { createdAt: "desc" }, take: 300, select: { productId: true } }),
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

export async function searchShops(query: string, marketId: MarketId, offset = 0, limit = 20) {
  const shops = await getDb().marketplaceShop.findMany({ where: { AND: [sellerVisibility(marketId), ...(query ? [{ OR: [
    { name: { contains: query, mode: "insensitive" as const } }, { slug: { contains: query.toLowerCase() } },
  ] }] : [])] }, orderBy: [{ name: "asc" }, { id: "asc" }], skip: offset, take: limit,
    select: { ...summary, announcement: true, about: true,
      marketGrants: { where: { marketId, status: "APPROVED" }, select: {
        profile: { select: { announcement: true, about: true } },
      } },
    },
  });
  return shops.map(({ marketGrants, ...shop }) => ({
    ...shop,
    announcement: marketGrants[0]?.profile?.announcement ?? shop.announcement,
    about: marketGrants[0]?.profile?.about ?? shop.about,
  }));
}

export function shopperOrders(shopperId: string | undefined, guestKey: string | null) {
  return getDb().order.findMany({ where: { OR: [
    ...(shopperId ? [{ shopperId }] : []),
    ...(guestKey ? [{ shopperId: null, attempt: { guestKey } }] : []),
  ] }, orderBy: { createdAt: "desc" }, take: 40,
  select: { id: true, reference: true, status: true, fulfillmentStatus: true, createdAt: true, totalMinor: true, currency: true, marketId: true, shopperId: true,
    payment: { select: { status: true } },
    bangladeshShipment: bangladeshTrackingSummary, bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
    parcels: shopperParcelSummary } });
}

export function threadsFor(viewer: { shopperId: string } | { platform: true }, marketId: MarketId) {
  const shopperId = "shopperId" in viewer ? viewer.shopperId : undefined;
  return getDb().shopperRequest.findMany({
    where: {
      ...(shopperId ? { shopperId } : { shopId: storeShop.id }),
      OR: [{ marketId, orderId: null }, { marketId: null, order: { marketId } },
        ...(marketId === defaultMarketId ? [{ marketId: null, orderId: null }] : []),
        shopperId ? { order: { shopperId } } : { marketId, order: { marketId } }],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 60,
    select: { id: true, subject: true, closed: true, updatedAt: true, marketId: true,
      shop: { select: summary }, order: { select: { reference: true, marketId: true } },
      product: { select: { name: true } } },
  });
}

export { buyerSupportThread as userThread } from "./buyer-support.ts";
