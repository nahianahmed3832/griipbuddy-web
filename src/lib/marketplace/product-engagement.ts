import type { MarketId } from "../../config/markets.ts";
import { catalogVariantWhere } from "../catalog/connected-public.ts";
import { getDb } from "../db/client.ts";
import { storeShop } from "./constants.ts";
import { sellerVisibility } from "./market-grants.ts";

export const reviewSorts = [["latest", "Most recent"], ["highest", "Highest rating"], ["lowest", "Lowest rating"]] as const;
export type ReviewSort = (typeof reviewSorts)[number][0];
const reviewsPerPage = 8;
const maximumPage = 100;

export function reviewPage(value: string | string[] | undefined) {
  return typeof value === "string" && /^[1-9]\d{0,3}$/.test(value) ? Math.min(Number(value), maximumPage) : 1;
}

export async function productReviews(productId: string, marketId: MarketId, sort: ReviewSort, requestPage: number, db = getDb()) {
  const where = {
    productId, visible: true, order: { marketId, status: "PLACED", fulfillmentStatus: "DELIVERED", items: { some: { variant: { productId } } } },
    product: { variants: { some: catalogVariantWhere(marketId) } },
  } as const;
  const sorting = sort === "latest" ? {}
    : { stars: sort === "highest" ? "desc" as const : "asc" as const };
  return db.$transaction(async tx => {
    const bins = await tx.shopperReview.groupBy({ where, by: ["stars"], _count: true });
    const total = bins.reduce((count, bin) => count + bin._count, 0);
    const pages = Math.max(1, Math.min(maximumPage, Math.ceil(total / reviewsPerPage)));
    const page = Math.min(Math.max(1, requestPage), pages);
    const entries = await tx.shopperReview.findMany({ where, orderBy: [sorting, { createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * reviewsPerPage, take: reviewsPerPage,
      select: { id: true, stars: true, text: true, createdAt: true } });
    return { total, page, pages, entries, bins,
      average: total ? bins.reduce((sum, bin) => sum + bin.stars * bin._count, 0) / total : null };
  }, { isolationLevel: "RepeatableRead" });
}

export async function productQuestionShop(productId: string, marketId: MarketId, db = getDb()) {
  const product = await db.product.findFirst({
    where: { id: productId, variants: { some: catalogVariantWhere(marketId, true) } },
    select: { marketplaceShopId: true },
  });
  if (!product) return null;
  return db.marketplaceShop.findFirst({
    where: { AND: [{ id: product.marketplaceShopId ?? storeShop.id }, sellerVisibility(marketId)] },
    select: { id: true, name: true, slug: true },
  });
}
