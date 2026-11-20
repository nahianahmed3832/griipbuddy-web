import type { MarketId } from "@/config/markets";
import { catalogVariantWhere } from "@/lib/catalog/connected-public";
import type { ProductCardData } from "@/lib/catalog/listing";
import { getDb } from "@/lib/db/client";
import { cardsById } from "./data";

export type SavedProduct = {
  id: string;
  name: string;
  card?: ProductCardData;
  slug?: string;
  archived?: boolean;
};

export async function savedProductCards(ids: readonly string[], marketId: MarketId, owner: boolean): Promise<SavedProduct[]> {
  const cards = new Map((await cardsById(marketId, ids)).map(card => [card.id, card]));
  const missing = ids.filter(id => !cards.has(id));
  const products = missing.length ? await getDb().product.findMany({
    where: { id: { in: missing } },
    select: { id: true, name: true, slug: true, publication: true,
      variants: { where: catalogVariantWhere(marketId), take: 1, select: { id: true } },
    },
  }) : [];
  const remaining = new Map(products.map(product => [product.id, product]));
  return ids.flatMap<SavedProduct>(id => {
    const card = cards.get(id);
    if (card) return { id, name: card.name, card };
    const product = remaining.get(id);
    if (!product) return [];
    if (product.variants.length) return { id, name: product.name, slug: product.slug };
    if (!owner) return [];
    return { id, name: product.publication === "DRAFT" ? "Saved product" : product.name,
      archived: product.publication === "ARCHIVED" };
  });
}
