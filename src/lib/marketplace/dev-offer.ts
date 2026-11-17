import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { hybridDemoMode } from "../release-config.ts";
import { storeShop } from "./constants.ts";

const day = 86_400_000;
const origin = "https://dev.griipbuddy.com";
const mongoId = /^[a-f0-9]{24}$/;
const pricePageSize = 60;
const text = z.string().max(1000);
export const devOffer = z.object({
  offer_start_date: z.iso.datetime(), validFor: z.number().min(1), specialSaleActive: z.boolean().optional(),
  discountPercentage: z.number().min(0).max(100).default(0), freeDelivery: z.boolean().default(false),
  applied_subcategories: z.array(z.object({ _id: z.string().regex(/^[a-f0-9]{24}$/) })).default([]),
  navbar_label: text.optional(),
  pageConf: z.object({
    title: text.optional(),
    header: z.object({ label: text, title_1: text, title_2: text, description: text, button_label: text }).optional(),
    timer_config: z.object({ show_timer: z.boolean(), mode: z.enum(["countdown", "12h_timer", "24h_timer"]) }).optional(),
  }).optional(),
});

type Offer = z.infer<typeof devOffer>;
type OfferVariant = { id: string; productId: string; product: { marketplaceShopId: string | null } };
type SourcePrice = { productId: string; subcategoryId: string; regularMinor: number };
const offerResponse = z.object({ offer: devOffer.nullish(), prices: z.array(z.object({
  productId: z.string().regex(/^p-[a-f0-9]{24}$/), variantId: z.string().regex(/^v-[a-f0-9]{24}$/),
  subcategoryId: z.string().regex(mongoId), regularMinor: z.number().int().positive(),
})) });

function sourceVariant(variant: OfferVariant) {
  const shopId = variant.product.marketplaceShopId;
  return (shopId === null || shopId === storeShop.id) && variant.productId.startsWith("p-") &&
    mongoId.test(variant.productId.slice(2)) && variant.id.startsWith("v-") && mongoId.test(variant.id.slice(2));
}

async function readOfferPrices(ids: string[], fetchRequest: typeof fetch) {
  const result = await fetchRequest(origin + "/api/dev-admin-content?product_ids=" + ids.join(","), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2500),
  });
  if (!result.ok) throw new Error("Could not verify dev offer pricing.");
  return offerResponse.parse(await result.json());
}

export function activeOffer(offer: Offer | null | undefined, now = Date.now()) {
  if (!offer?.specialSaleActive) return null;
  const start = Date.parse(offer.offer_start_date);
  const end = start + offer.validFor * day;
  return start <= now && now < end ? { ...offer, start, end, now } : null;
}

export function offerTimerEnd(offer: NonNullable<ReturnType<typeof activeOffer>>, now: number) {
  const settings = offer.pageConf?.timer_config;
  if (!settings?.show_timer) return null;
  const cycle = settings.mode === "12h_timer" ? day / 2 : settings.mode === "24h_timer" ? day : null;
  return cycle ? Math.min(offer.end, offer.start + cycle * (Math.floor((now - offer.start) / cycle) + 1)) : offer.end;
}

export function matchedOfferPrice(offer: NonNullable<ReturnType<typeof activeOffer>>, source: SourcePrice) {
  if (!offer.applied_subcategories.some(row => row._id === source.subcategoryId)) return null;
  const amountMinor = Math.round(source.regularMinor * (1 - offer.discountPercentage / 100));
  return { amountMinor, regularMinor: source.regularMinor, freeDelivery: offer.freeDelivery };
}

export async function devOfferPricing(marketId: MarketId, variants: readonly OfferVariant[], now: Date, fetchRequest = fetch) {
  if (marketId !== "bd" || !hybridDemoMode() || process.env.COMMERCE_MODE !== "staging") return null;
  const ids = [...new Set(variants.filter(sourceVariant).map(variant => variant.productId.slice(2)))];
  if (!ids.length) return null;

  const first = await readOfferPrices(ids.slice(0, pricePageSize), fetchRequest);
  const campaign = activeOffer(first.offer, now.getTime());
  if (!campaign) return null;
  const catalog = new Map(first.prices.map(price => [price.variantId, price]));
  const otherPages = Array.from({ length: Math.ceil(ids.length / pricePageSize) - 1 }, (_, index) => (index + 1) * pricePageSize);
  const queue = otherPages.values();
  const offer = JSON.stringify(first.offer);
  await Promise.all(Array.from({ length: Math.min(4, otherPages.length) }, async () => {
    for (const offset of queue) {
      const result = await readOfferPrices(ids.slice(offset, offset + pricePageSize), fetchRequest);
      if (JSON.stringify(result.offer) !== offer) throw new Error("Offer pricing changed during the catalog read.");
      for (const price of result.prices) catalog.set(price.variantId, price);
    }
  }));
  return {
    end: new Date(campaign.end),
    price(variant: OfferVariant, fallback: { amountMinor: number; regularMinor: number }) {
      const source = catalog.get(variant.id);
      if (!sourceVariant(variant) || source?.productId !== variant.productId) return null;
      const price = matchedOfferPrice(campaign, source);
      // A delivery-only offer preserves the existing sale price.
      return price && (campaign.discountPercentage > 0 ? price : { ...fallback, freeDelivery: price.freeDelivery });
    },
  };
}
