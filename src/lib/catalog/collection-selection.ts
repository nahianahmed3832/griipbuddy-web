import { marketIds, type MarketId } from "../../config/markets.ts";
import type { CollectionSelection, Prisma } from "../../generated/prisma/client.ts";
import { isMarketSelectable } from "../market-config.ts";

export const orderedCollectionProducts = [
  { position: { sort: "asc", nulls: "last" } }, { product: { position: "asc" } }, { productId: "asc" },
] satisfies Prisma.CollectionProductOrderByWithRelationInput[];

export function connectedCollectionProductFilter(collection: { id: string; selection: CollectionSelection }): Prisma.ProductWhereInput {
  if (collection.selection === "NEW") return { newArrival: true };
  if (collection.selection === "FEATURED") return { featured: true };
  return { collections: { some: { collectionId: collection.id } } };
}

function visibleInMarket(marketId: MarketId): Prisma.CollectionWhereInput {
  return { OR: [
    { marketPublications: { some: { marketId, published: true } } },
    { defaultPublished: true, marketPublications: { none: { marketId } } },
  ] };
}

export function publicCollectionScope(marketId?: MarketId): Prisma.CollectionWhereInput {
  return marketId === undefined ? { OR: marketIds.filter(isMarketSelectable).map(visibleInMarket) } : visibleInMarket(marketId);
}
