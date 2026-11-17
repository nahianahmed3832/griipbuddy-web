import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";
import { hybridDemoMode } from "../release-config";
import { devOffer } from "./dev-offer";

export { activeOffer } from "./dev-offer";

const origin = "https://dev.griipbuddy.com";
const assetPrefix = "/editorial/dev-admin/";
const fileKey = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.(?:jpe?g|png|webp|avif|gif|mp4|webm)$/i;
const text = z.string().max(1000);
const reference = z.object({ _id: text.optional(), slug: text.optional(), sku: text.optional() });
const position = z.number().optional();
const banner = z.object({ banner_url: text, products_id: z.array(text).optional() });
const productGroup = z.object({ name: text, slug: text, position, product_ids: z.array(reference).optional() });
const data = z.object({
  content: z.object({
    top_bar_messages: z.array(z.object({ message: text, position })).optional(),
    hero_section: z.array(z.object({
      title: text, video_url: text.optional(), thumbnail_url: text.optional(), position,
      button: z.object({ enabled: z.boolean(), text: text.optional(), redirect_route: text.optional() }).optional(),
    })).optional(),
    banners: z.array(banner).optional(),
    mobile_banners: z.array(banner).optional(),
    featured_products: z.array(banner).optional(),
  }).nullish(),
  homepage: z.object({
    shop_by_category: z.array(z.object({
      category_id: reference.nullish(), subcategory_id: reference.nullish(),
      label: text.optional(), icon_image_url: text.optional(), position,
    })).optional(),
    best_selling: z.array(z.object({ product_id: reference, position })).optional(),
    new_arrivals: z.array(productGroup).optional(),
    leather_section: z.object({
      enabled: z.boolean(), title: text, subtitle: text.optional(), button_text: text.optional(), button_link: text.optional(),
      banner_image_url: text.optional(), product_ids: z.array(reference).optional(),
    }).nullish(),
  }).nullish(),
  offer: devOffer.nullish(),
});

export type AdminContent = z.infer<typeof data>;

export const readAdminContent = cache(async (): Promise<AdminContent | null> => {
  if (!hybridDemoMode() || (await headers()).get("x-forwarded-host") !== "dev.griipbuddy.com") return null;
  try {
    const response = await fetch(origin + "/api/dev-admin-content", {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const parsed = data.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
});

export function ordered<T extends { position?: number }>(rows: readonly T[] = []): T[] {
  return [...rows].sort((first, second) => (first.position ?? 0) - (second.position ?? 0));
}

export function adminMedia(value: string | undefined): string | undefined {
  if (!value) return;
  if (fileKey.test(value)) return assetPrefix + value;
  if (/^\/?(?:uploads|videos|catalog)\/[a-z\d/_-]+\.[a-z\d]{3,4}$/i.test(value)) {
    return "https://d11ml80zmgyrxk.cloudfront.net/" + value.replace(/^\//, "");
  }
  try {
    const url = new URL(value);
    if (url.username || url.password || url.protocol !== "https:") return;
    const prefix = "/admin/api/media/catalog/";
    const key = url.pathname.slice(prefix.length);
    if (url.hostname === "devadmin.griipbuddy.com" && url.pathname.startsWith(prefix) && fileKey.test(key)) {
      return assetPrefix + key;
    }
    if (["d11ml80zmgyrxk.cloudfront.net", "ggbook.s3.us-east-1.amazonaws.com"].includes(url.hostname)) return url.href;
  } catch {
    return;
  }
}

export function adminLink(value: string | undefined, fallback: string): string {
  if (value?.startsWith("/") && !/^\/[\\/]|[\\\r\n]/.test(value)) return value;
  const href = value ? URL.parse(value) : null;
  if (href?.origin === "https://griipbuddy.com" && !href.username && !href.password) return href.href;
  return fallback;
}
