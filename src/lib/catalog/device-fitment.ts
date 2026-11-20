import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { marketFoundationVariant } from "./product-foundation.ts";

export function deviceLookupKey(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

export async function resolveDeviceModel(text: string, db: DbReader = getDb()) {
  const lookupKey = deviceLookupKey(text);
  if (!lookupKey || lookupKey.length > 240) return null;
  return db.deviceModel.findFirst({
    where: { OR: [{ lookupKey }, { aliases: { some: { lookupKey } } }] },
    select: { id: true, brand: true, name: true },
  });
}

export async function compatibleVariantIds(modelId: string, marketId: MarketId, db: DbReader = getDb()) {
  if (!isMarketSelectable(marketId)) return [];
  const variants = await db.variant.findMany({
    where: {
      ...marketFoundationVariant(marketId, true),
      compatibility: { some: { modelId } },
      product: { foundation: true, active: true, publication: "ACTIVE" },
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return variants.map(({ id }) => id);
}
