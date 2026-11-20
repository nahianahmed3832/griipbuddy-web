import * as z from "zod/mini";
import { marketIds, marketList, type Market } from "../../config/markets.ts";
import { regionalMarket, withoutRegionalPrefix } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { validCartOfferId, validVariantId } from "../cart/model.ts";
import type { getExactConnectedVariant } from "./connected-product.ts";
import { readSearchQuery } from "./search-query.ts";

type CatalogScope = Pick<Market, "id" | "locale" | "currency">;
type ExactVariant = NonNullable<Awaited<ReturnType<typeof getExactConnectedVariant>>>;
// The server's gallery array access infers an image even when the gallery is empty.
export type CatalogVariant = Omit<ExactVariant["variant"], "image"> & { image: ExactVariant["variant"]["image"] | null };

const text = z.string();
const marketId = z.enum(marketIds);
const currency = z.enum(marketList.map(market => market.currency));
const count = z.int().check(z.nonnegative());
const localPath = z.string().check(z.regex(/^\/(?!\/)[^\p{Cc}\s\\]*$/u));
const image = z.object({ src: localPath, alt: text });
const namedHit = z.object({ id: text, name: text, href: localPath });
const context = { marketId, locale: text };
const optionText = { key: text, label: text, value: text, valueLabel: text };

const suggestions = z.object({
  ...context,
  products: z.array(z.extend(namedHit, {
    slug: text, variantId: z.nullable(text), offerId: z.nullable(text), image: z.nullable(image), offerEligible: z.optional(z.boolean()),
    amountMinor: count, currency, priceQualifier: z.optional(z.enum(["from", "shown_option"])),
    match: z.nullable(z.object({ kind: z.enum(["sku", "model", "variant", "text", "spelling"]), label: text })),
  })).check(z.maxLength(6)),
  categories: z.array(namedHit).check(z.maxLength(4)),
  models: z.array(namedHit).check(z.maxLength(4)),
  keywords: z.optional(z.array(namedHit).check(z.maxLength(3))),
  shops: z.array(z.object({ id: text, name: text, slug: text })).check(z.maxLength(3)),
});

const exactVariant = z.object({
  ...context, currency,
  product: z.object({ id: text, slug: text }),
  variant: z.object({
    id: text, sku: text, label: text, position: z.int(), isDefault: z.boolean(),
    gtin: z.nullable(text), mpn: z.nullable(text),
    options: z.union([
      z.array(z.object({ ...optionText, optionId: text, valueId: text })),
      z.array(z.object({ ...optionText, optionId: z.null(), valueId: z.null() })),
    ]),
    attributes: z.record(text, z.union([text, z.number(), z.boolean()])),
    compatibility: z.array(z.object({ id: text, name: text, brand: text, aliases: z.array(text) })),
    gallery: z.array(image), image: z.nullable(image),
    availability: z.enum(["available", "out_of_stock", "delivery_unavailable", "browse_only"]),
    quantityLimit: z.optional(count),
    offer: z.object({
      id: z.nullable(text), variantId: text, marketId, sellerId: text, currency,
      amountMinor: count, regularMinor: count, eligible: z.boolean(), revision: count,
      promotionEndsAt: z.nullable(z.iso.datetime()),
    }),
  }),
}) satisfies z.ZodMiniType<Omit<ExactVariant, "variant"> & { variant: CatalogVariant }>;

export type CatalogSuggestions = z.infer<typeof suggestions>;

export class CatalogReadError extends Error {
  constructor(readonly status: number) {
    super(`Catalog request failed (${status}).`);
  }
}

async function readCatalog<Result extends { marketId: Market["id"]; locale: string }>(
  path: string, market: CatalogScope, params: URLSearchParams, schema: z.ZodMiniType<Result>, signal: AbortSignal,
) {
  params.set("market", market.id);
  params.set("lang", market.locale);
  const response = await fetch(storefrontPath(`${path}?${params}`), {
    mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
  });
  if (!response.ok) throw new CatalogReadError(response.status);
  const result = schema.safeParse(await response.json());
  if (!result.success || result.data.marketId !== market.id || result.data.locale !== market.locale) {
    throw new Error("Unexpected catalog response.");
  }
  return result.data;
}

export async function loadCatalogSuggestions(query: string, market: CatalogScope, signal: AbortSignal) {
  const term = readSearchQuery(query);
  if (term === null) throw new Error("Invalid catalog query.");
  const data = await readCatalog("/api/marketplace/suggest", market, new URLSearchParams({ q: term }), suggestions, signal);
  for (const hit of data.products) {
    const [path, params] = suggestionDestination(hit.href, market);
    const ids = params.getAll("variant");
    if (path !== `/products/${encodeURIComponent(hit.slug)}` || hit.currency !== market.currency ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hit.slug) ||
      (hit.variantId === null ? ids.length !== 0
        : !validVariantId(hit.variantId) || ids.length !== 1 || ids[0] !== hit.variantId || params.has("option")) ||
      (hit.offerId !== null && !validCartOfferId(hit.offerId))) {
      throw new Error("Unexpected product suggestion.");
    }
    if (hit.image?.src.startsWith("/media/")) {
      const imageMarket = new URL(hit.image.src, "https://storefront.invalid").searchParams.getAll("market");
      if (imageMarket.length !== 1 || imageMarket[0] !== market.id) throw new Error("Unexpected catalog image market.");
    }
  }
  for (const hit of data.categories) {
    const [path] = suggestionDestination(hit.href, market);
    if (!/^\/departments\/[^/]+$/.test(path)) throw new Error("Unexpected category suggestion.");
  }
  for (const hit of data.models) {
    const [path, params] = suggestionDestination(hit.href, market);
    if (path !== "/search" || params.getAll("model").length !== 1 || params.get("model") !== hit.id ||
      params.getAll("q").length !== 1 || params.get("q") !== hit.name) throw new Error("Unexpected model suggestion.");
  }
  for (const hit of data.keywords ?? []) {
    const [path, params] = suggestionDestination(hit.href, market);
    if (path !== "/search" || params.getAll("q").length !== 1 || params.get("q") !== hit.name) throw new Error("Unexpected keyword suggestion.");
  }
  return data;
}

function suggestionDestination(href: string, market: CatalogScope) {
  const url = new URL(href, "https://storefront.invalid");
  const regional = regionalMarket(url.pathname);
  const markets = url.searchParams.getAll("market");
  const locales = url.searchParams.getAll("lang");
  if ((regional && regional.id !== market.id) || url.hash ||
    markets.length !== 1 || markets[0] !== market.id || locales.length !== 1 || locales[0] !== market.locale) {
    throw new Error("Unexpected suggestion scope.");
  }
  return [withoutRegionalPrefix(url.pathname), url.searchParams] as const;
}

export async function loadExactCatalogVariant(productId: string, variantId: string, market: CatalogScope,
  deliveryQuery: string, signal: AbortSignal) {
  const path = `/api/catalog/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`;
  const data = await readCatalog(path, market, new URLSearchParams(deliveryQuery), exactVariant, signal);
  const { offer } = data.variant;
  if (data.product.id !== productId || data.variant.id !== variantId || data.currency !== market.currency ||
    offer.variantId !== variantId || offer.marketId !== market.id || offer.currency !== market.currency) {
    throw new Error("Unexpected variant or offer scope.");
  }
  return data.variant;
}
