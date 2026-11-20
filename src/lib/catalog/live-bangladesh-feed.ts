import { z } from "zod";
import type { MerchantFeedItem } from "./merchant-feed.ts";

const sourceApi = "https://api.griipbuddy.com/api/v1";
const liveStore = "https://griipbuddy.com";
const liveImages = "https://d11ml80zmgyrxk.cloudfront.net";
const mongoId = /^[a-f0-9]{24}$/;
const catalogImage = /^uploads\/[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp)$/i;
const sourceId = z.string().regex(mongoId);
const sourceMedia = z.array(z.string()).nullish();
const sourceProduct = z.object({
  product: z.object({
    _id: sourceId, slug: z.string(), is_published: z.boolean(), region: z.string().nullish(),
    catalog_state: z.string().nullish(), sale_channels: z.object({ website: z.boolean().optional() }).nullish(),
    subcategory: z.object({ _id: sourceId }).nullish(), thumbnail: z.string().nullish(), slider_images: sourceMedia,
  }),
  variants: z.array(z.object({
    _id: sourceId, product: sourceId, sale_price: z.number().nullish(), regular_price: z.number().nullish(),
    image: z.string().nullish(), images: sourceMedia,
  })),
});
const sourceCampaign = z.discriminatedUnion("specialSaleActive", [
  z.object({ specialSaleActive: z.literal(false) }),
  z.object({
    specialSaleActive: z.literal(true), offer_start_date: z.iso.datetime(), validFor: z.number().nonnegative(),
    discountPercentage: z.number().min(0).lt(100), applied_subcategories: z.array(z.object({ _id: sourceId })),
  }),
]);
const sourceStock = z.object({ totalAvailableQuantity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });

function getCandidate(item: MerchantFeedItem) {
  const productId = item.productId.startsWith("p-") ? item.productId.slice(2) : "";
  const variantId = item.variantId.startsWith("v-") ? item.variantId.slice(2) : "";
  const slug = URL.parse(item.link)?.pathname.match(/\/products\/([a-z0-9][a-z0-9-]{0,119})$/)?.[1];
  if (item.currency !== "BDT" || !mongoId.test(productId) || !mongoId.test(variantId) || !slug) return null;
  return { item, productId, variantId, slug };
}

async function readSource<T>(fetchRequest: typeof fetch, path: string, schema: z.ZodType<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetchRequest(sourceApi + path, {
    cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (response.status === 404 && path.startsWith("/product/slug/")) return null;
  if (!response.ok) throw new Error(`Live Bangladesh catalog request failed (${response.status}).`);
  return z.object({ success: z.literal(true), data: schema }).parse(await response.json()).data;
}

function effectiveAmount(
  variant: z.infer<typeof sourceProduct>["variants"][number],
  subcategoryId: string | undefined,
  campaign: z.infer<typeof sourceCampaign>,
  now: number,
) {
  const regular = variant.regular_price ?? 0;
  const sale = variant.sale_price ?? 0;
  let price = sale > 0 ? sale : regular;
  if (campaign.specialSaleActive && campaign.discountPercentage > 0 &&
      campaign.applied_subcategories.some(({ _id }) => _id === subcategoryId)) {
    const start = Date.parse(campaign.offer_start_date);
    const end = start + campaign.validFor * 86_400_000;
    if (start <= now && now < end) price = regular * (1 - campaign.discountPercentage / 100);
  }
  const amountMinor = Math.round(price * 100);
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 ? amountMinor : null;
}

export async function refreshBangladeshMerchantItems(items: readonly MerchantFeedItem[], fetchRequest: typeof fetch = fetch) {
  const groups = new Map<string, NonNullable<ReturnType<typeof getCandidate>>[]>();
  for (const item of items) {
    const candidate = getCandidate(item);
    if (candidate) groups.set(candidate.slug, [...(groups.get(candidate.slug) ?? []), candidate]);
  }
  const refreshed = new Map<string, MerchantFeedItem>();
  if (groups.size > 0) {
    const signal = AbortSignal.timeout(15_000);
    const campaign = await readSource(fetchRequest, "/cms/offer-page", sourceCampaign, signal);
    if (!campaign) throw new Error("Live Bangladesh campaign settings are unavailable.");
    const queue = groups.entries();
    const now = Date.now();
    const worker = async () => {
      for (const [slug, candidates] of queue) {
        const source = await readSource(fetchRequest, "/product/slug/" + slug, sourceProduct, signal);
        if (!source) continue;
        const { product, variants } = source;
        if (!product.is_published || product.sale_channels?.website !== true ||
            (product.region != null && product.region !== "BD") ||
            (product.catalog_state != null && product.catalog_state !== "published")) continue;

        // The live landing page has not established a variant query contract. Only link
        // to a product when its single public variant matches this verified feed row.
        if (product.slug !== slug || variants.length !== 1) continue;
        const variant = variants[0];
        const candidate = candidates.find(row => row.productId === product._id && row.variantId === variant._id);
        if (!candidate || variant.product !== product._id) continue;

        const image = [variant.image, ...(variant.images ?? []), product.thumbnail, ...(product.slider_images ?? [])]
          .find((path): path is string => typeof path === "string" && catalogImage.test(path));
        const amountMinor = effectiveAmount(variant, product.subcategory?._id, campaign, now);
        if (amountMinor === null || !image) continue;
        const availability = await readSource(fetchRequest, `/stocks/${product._id}/${variant._id}`, sourceStock, signal);
        if (!availability) throw new Error("Live Bangladesh stock is unavailable.");
        const stock = availability.totalAvailableQuantity;
        refreshed.set(candidate.item.variantId, {
          ...candidate.item, amountMinor, stock, availability: stock > 0 ? "in_stock" : "out_of_stock",
          link: `${liveStore}/bd/product/${slug}`, imageLink: `${liveImages}/${image}`,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(groups.size, 4) }, worker));
  }
  return {
    items: items.flatMap(item => refreshed.get(item.variantId) ?? []),
    unavailableVariantIds: items.filter(item => !refreshed.has(item.variantId)).map(item => item.variantId),
  };
}
