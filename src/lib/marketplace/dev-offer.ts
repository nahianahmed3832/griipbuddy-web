import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { hybridDemoMode } from "../release-config.ts";
import { storeShop } from "./constants.ts";
import sourcePrices from "../catalog/dev-bd-prices.json" with { type: "json" };

const day = 86_400_000;
const origin = "https://dev.griipbuddy.com";
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
const catalog: Readonly<Record<string, SourcePrice | undefined>> = sourcePrices;
const offerResponse = z.object({ offer: devOffer.nullish() });

function sourcePrice(variant: OfferVariant) {
  const shopId = variant.product.marketplaceShopId;
  const source = catalog[variant.id];
  return (shopId === null || shopId === storeShop.id) && source?.productId === variant.productId ? source : null;
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

export async function devOfferPricing(marketId: MarketId, variants: readonly OfferVariant[], now: Date) {
  if (marketId !== "bd" || !hybridDemoMode() || process.env.COMMERCE_MODE !== "staging" ||
      !variants.some(variant => sourcePrice(variant))) return null;

  const response = await fetch(origin + "/api/dev-admin-content", {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error("Could not verify dev offer pricing.");
  const { offer } = offerResponse.parse(await response.json());
  const campaign = activeOffer(offer, now.getTime());
  if (!campaign) return null;
  return {
    end: new Date(campaign.end),
    price(variant: OfferVariant, fallback: { amountMinor: number; regularMinor: number }) {
      const source = sourcePrice(variant);
      const price = source && matchedOfferPrice(campaign, source);
      // A delivery-only offer preserves the existing sale price.
      return price && (campaign.discountPercentage > 0 ? price : { ...fallback, freeDelivery: price.freeDelivery });
    },
  };
}
