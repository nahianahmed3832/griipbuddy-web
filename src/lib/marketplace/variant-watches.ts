import type { Prisma } from "../../generated/prisma/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { catalog } from "../catalog/repository.ts";
import { getDb } from "../db/client.ts";

export type VariantWatchOptions = { backInStock: boolean; priceDrop: boolean };
export type VariantWatchInput = VariantWatchOptions & { variantId: string; marketId: MarketId };

export class VariantWatchError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

const maximumWatches = 100;
const recentAlerts = 50;

async function lockShopperWatches(tx: Prisma.TransactionClient, shopperId: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${shopperId}), 1134)`;
}

export function variantWatchSettings(shopperId: string, marketId: MarketId, variantIds: readonly string[]) {
  return getDb().shopperVariantWatch.findMany({ where: { shopperId, marketId, variantId: { in: [...variantIds] } },
    select: { variantId: true, backInStock: true, priceDrop: true } });
}

export async function updateVariantWatch(shopperId: string, input: VariantWatchInput) {
  const db = getDb();
  const where = { shopperId, variantId: input.variantId, marketId: input.marketId };
  const active = input.backInStock || input.priceDrop;
  const [variant] = active ? await catalog.resolveVariants([input.variantId], input.marketId) : [];
  const offer = variant?.offer;
  return db.$transaction(async tx => {
    await lockShopperWatches(tx, shopperId);
    if (!active) {
      await tx.shopperVariantWatch.deleteMany({ where });
      return { backInStock: false, priceDrop: false };
    }
    const saved = await tx.shopperVariantWatch.findUnique({ where: { shopperId_variantId_marketId: where } });
    const enableStock = input.backInStock && !saved?.backInStock;
    const enablePrice = input.priceDrop && !saved?.priceDrop;
    if ((enableStock || enablePrice) && !offer) throw new VariantWatchError("This variant isn’t offered in that market.", 404);
    const options = { backInStock: input.backInStock, priceDrop: input.priceDrop };
    if (saved?.backInStock === input.backInStock && saved.priceDrop === input.priceDrop) return options;

    // A preference change for one alert leaves the other alert's observed baseline intact.
    const changes = { ...options,
      lastAvailable: input.backInStock ? (enableStock ? (offer?.stock ?? 0) > 0 : saved?.lastAvailable ?? null) : null,
      lastPriceMinor: input.priceDrop ? (enablePrice ? offer?.amountMinor ?? null : saved?.lastPriceMinor ?? null) : null,
    };
    if (saved) {
      await tx.shopperVariantWatch.update({ where: { id: saved.id }, data: changes });
    } else {
      if (await tx.shopperVariantWatch.count({ where: { shopperId } }) >= maximumWatches) {
        throw new VariantWatchError(`Remove a product alert before adding another. You can save up to ${maximumWatches} watches.`, 409);
      }
      await tx.shopperVariantWatch.create({ data: { ...where, ...changes } });
    }
    return options;
  });
}

const alertProduct = { select: { label: true, product: { select: { name: true, slug: true } } } } as const;
const watchSummary = { id: true, variantId: true, marketId: true, backInStock: true, priceDrop: true, variant: alertProduct } as const;

export async function evaluateVariantWatches(shopperId: string) {
  const db = getDb();
  const snapshot = await db.shopperVariantWatch.findMany({ where: { shopperId },
    select: { id: true, marketId: true, variantId: true, updatedAt: true, backInStock: true, priceDrop: true, lastAvailable: true, lastPriceMinor: true },
  });
  if (!snapshot.length) return { watches: [], events: [] };

  const watchMarkets = [...new Set(snapshot.map(watch => watch.marketId))];
  const variants = await Promise.all(watchMarkets.map(async marketId => [marketId, new Map(
    (await catalog.resolveVariants(snapshot.filter(watch => watch.marketId === marketId).map(watch => watch.variantId), marketId))
      .map(variant => [variant.variantId, variant.offer]),
  )] as const));
  const offers = new Map(variants);
  const sampledWatches = new Map(snapshot.map(watch => [watch.id, watch]));

  return db.$transaction(async tx => {
    await lockShopperWatches(tx, shopperId);
    const watches = await tx.shopperVariantWatch.findMany({ where: { shopperId },
      select: { ...watchSummary, updatedAt: true, lastAvailable: true, lastPriceMinor: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    for (const watch of watches) {
      // A later evaluation or preference change won the race against this catalog read.
      const sample = sampledWatches.get(watch.id);
      if (!sample || sample.updatedAt.getTime() !== watch.updatedAt.getTime() || sample.backInStock !== watch.backInStock ||
          sample.priceDrop !== watch.priceDrop || sample.lastAvailable !== watch.lastAvailable || sample.lastPriceMinor !== watch.lastPriceMinor) continue;
      const offer = offers.get(watch.marketId)?.get(watch.variantId) ?? null;
      const available = (offer?.stock ?? 0) > 0;
      const amountMinor = offer?.amountMinor ?? null;
      const events: Prisma.ShopperVariantWatchEventCreateManyInput[] = [];
      if (watch.backInStock && watch.lastAvailable === false && available) {
        events.push({ watchId: watch.id, kind: "BACK_IN_STOCK", amountMinor });
      }
      if (watch.priceDrop && amountMinor !== null && watch.lastPriceMinor !== null && amountMinor < watch.lastPriceMinor) {
        events.push({ watchId: watch.id, kind: "PRICE_DROP", amountMinor, previousAmountMinor: watch.lastPriceMinor });
      }
      const lastAvailable = watch.backInStock ? available : null;
      const lastPriceMinor = watch.priceDrop ? amountMinor : null;
      if (lastAvailable !== watch.lastAvailable || lastPriceMinor !== watch.lastPriceMinor) {
        await tx.shopperVariantWatch.update({ where: { id: watch.id }, data: { lastAvailable, lastPriceMinor } });
      }
      if (events.length) await tx.shopperVariantWatchEvent.createMany({ data: events });
    }
    const events = await tx.shopperVariantWatchEvent.findMany({ where: { watch: { shopperId } },
      select: { id: true, kind: true, amountMinor: true, previousAmountMinor: true, createdAt: true, watch: { select: watchSummary } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: recentAlerts,
    });
    return { watches, events };
  });
}
