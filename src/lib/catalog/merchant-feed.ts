import { createHash } from "node:crypto";
import { markets, type Currency, type MarketId } from "../../config/markets.ts";
import { localizedStorePath } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { merchantProductUrl, merchantVariantDetails } from "./merchant-fields.ts";
import type { CatalogProduct, ListedVariant } from "./types.ts";

export type MerchantFeedSettings = { marketId: MarketId; origin: string; regional: boolean; includeDemo?: boolean; channelUrl?: string };

export type MerchantFeedIssue = {
  productId: string;
  productName: string;
  variantId: string;
  code: "demo" | "missing_brand" | "missing_description" | "missing_image" | "invalid_offer" |
    "missing_identifiers" | "missing_gtin" | "invalid_gtin" | "conflicting_identifiers" | "variant_group" | "live_unverified";
  severity: "excluded" | "review";
};

type VariantOption = readonly [name: string, value: string];
export type MerchantFeedItem = {
  id: string;
  productId: string;
  variantId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  availability: "in_stock" | "out_of_stock";
  amountMinor: number;
  currency: Currency;
  stock: number;
  brand?: string;
  gtin?: string;
  mpn?: string;
  identifierExists?: "no";
  size?: string;
  color?: string;
  material?: string;
  pattern?: string;
  itemGroupId?: string;
  itemGroupTitle?: string;
  variantOptions?: readonly VariantOption[];
};

function cleanText(value: string) {
  // A product field can have been imported from outside this database. Retain only XML 1.0 characters.
  return [...value].filter(character => {
    const point = character.codePointAt(0)!;
    return point === 9 || point === 10 || point === 13 ||
      (point >= 32 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) || point >= 0x10000;
  }).join("").trim();
}

function clip(value: string, max: number) {
  return [...cleanText(value)].slice(0, max).join("").trimEnd();
}

function feedId(value: string) {
  // Normal IDs are preserved, while long catalogue IDs still fit Google's 50-character limit.
  return value.length <= 50 ? value : `griip:${createHash("sha256").update(value).digest("base64url")}`;
}

function productImageUrl(src: string | undefined, origin: string) {
  if (!src || !/^\/(?![\\/])/.test(src)) return undefined;
  try {
    const url = new URL(storefrontPath(src), origin);
    const storefront = new URL(origin);
    if (url.origin === storefront.origin && (url.protocol === "https:" || url.protocol === "http:")) return url.href;
  } catch {
    return undefined;
  }
}

function groupingOptions(variant: ListedVariant): VariantOption[] {
  return Object.entries(variant.options)
    .map(([name, value]) => [clip(name, 250), clip(value, 250)] as const)
    .filter(([name, value]) => name && value)
    .sort(([first], [second]) => first.localeCompare(second, "en"));
}

function variantGroup(variants: readonly ListedVariant[]) {
  if (variants.length < 2) return null;
  const configurations = variants.map(groupingOptions);
  const keys = configurations[0].map(([name]) => name);
  if (!keys.length || keys.length > 30 || new Set(keys).size !== keys.length ||
      !configurations.every(options => options.length === keys.length &&
        options.every(([name], index) => name === keys[index])) ||
      new Set(configurations.map(options => JSON.stringify(options))).size !== configurations.length) return null;
  return new Map(variants.map((variant, index) => [variant.id, configurations[index]]));
}

export function collectMerchantFeed(products: readonly CatalogProduct[], settings: MerchantFeedSettings) {
  const { marketId, origin, regional, includeDemo = false } = settings;
  const items: MerchantFeedItem[] = [];
  const issues: MerchantFeedIssue[] = [];
  for (const product of products) {
    const variants = product.variants.filter(variant => variant.offer !== null);
    const optionsById = variantGroup(variants);
    for (const variant of variants) {
      const issue = (code: MerchantFeedIssue["code"], severity: MerchantFeedIssue["severity"]) => {
        issues.push({ productId: product.id, productName: product.name, variantId: variant.id, code, severity });
      };
      if (product.demo && !includeDemo) {
        issue("demo", "excluded");
        continue;
      }
      const offer = variant.offer!;
      const { brand, gtin, mpn, size, color, material, pattern } = merchantVariantDetails(product, variant);
      const title = clip(product.name, 150);
      const description = clip(product.shortDescription ?? "", 5000) || clip(product.description, 5000);
      const imageLink = productImageUrl((variant.image ?? product.images[0])?.src, origin);
      const noIdentifiers = variant.identifiersNotAssigned === true;
      const invalidGtin = Boolean(variant.gtin && !gtin);
      const conflictingIdentifiers = noIdentifiers && Boolean(variant.gtin || variant.mpn);
      const missingIdentifiers = !noIdentifiers && !variant.gtin && !mpn;
      const missingBrand = !brand && !noIdentifiers;
      if (missingBrand) issue("missing_brand", "excluded");
      if (invalidGtin) issue("invalid_gtin", "excluded");
      if (conflictingIdentifiers) issue("conflicting_identifiers", "excluded");
      if (missingIdentifiers) issue("missing_identifiers", "excluded");
      if (!title || !description) issue("missing_description", "excluded");
      if (!imageLink) issue("missing_image", "excluded");
      const validOffer = offer.variantId === variant.id && offer.marketId === marketId &&
        offer.currency === markets[marketId].currency && Number.isSafeInteger(offer.amountMinor) && offer.amountMinor > 0 &&
        Number.isSafeInteger(offer.stock) && offer.stock >= 0;
      if (!validOffer) issue("invalid_offer", "excluded");
      if (missingBrand || invalidGtin || conflictingIdentifiers || missingIdentifiers ||
          !title || !description || !imageLink || !validOffer) continue;
      if (!gtin && !noIdentifiers) issue("missing_gtin", "review");
      const variantOptions = optionsById?.get(variant.id);
      if (variants.length > 1 && !variantOptions) issue("variant_group", "review");
      const values = groupingOptions(variant).map(([, value]) => value);
      items.push({
        id: feedId(variant.id), productId: product.id, variantId: variant.id,
        title: values.length ? clip(`${title} – ${values.join(" / ")}`, 150) : title,
        description, link: merchantProductUrl(origin, product.slug, marketId, regional, variant.id), imageLink,
        availability: offer.stock > 0 ? "in_stock" : "out_of_stock", amountMinor: offer.amountMinor,
        currency: offer.currency, stock: offer.stock, brand, gtin, mpn, size, color, material, pattern,
        ...(noIdentifiers && { identifierExists: "no" }),
        ...(variantOptions && { itemGroupId: feedId(product.id), itemGroupTitle: title, variantOptions }),
      });
    }
  }
  return { items, issues };
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
function escapeXml(value: string) {
  return cleanText(value).replace(/[&<>"']/g, character => entities[character]);
}

export const metaFeedConditions = ["new", "refurbished", "used"] as const;
export type MetaFeedCondition = (typeof metaFeedConditions)[number];

export function merchantFeedXml(items: readonly MerchantFeedItem[], { marketId, origin, regional, channelUrl }: MerchantFeedSettings,
  provider?: { metaCondition: MetaFeedCondition }) {
  const market = markets[marketId];
  const title = `GriipBuddy – ${market.name}`;
  const marketUrl = channelUrl ?? new URL(storefrontPath(regional ? localizedStorePath("/", marketId) : "/"), origin).href;
  const itemXml = items.map(item => {
    const price = (item.amountMinor / 10 ** market.minorDigits).toFixed(market.minorDigits);
    const fields = {
      id: item.id, title: item.title, description: item.description, link: item.link, image_link: item.imageLink,
      availability: provider ? item.availability.replaceAll("_", " ") : item.availability,
      ...(provider && { condition: provider.metaCondition }), price: `${price} ${item.currency}`, brand: item.brand, gtin: item.gtin, mpn: item.mpn,
      identifier_exists: provider ? undefined : item.identifierExists,
      size: item.size, color: item.color, material: item.material, pattern: item.pattern,
      item_group_id: item.itemGroupId, item_group_title: provider ? undefined : item.itemGroupTitle,
    };
    return [
      "    <item>",
      ...Object.entries(fields).filter(([, value]) => value).map(([key, value]) =>
        `      <g:${key}>${escapeXml(value!)}</g:${key}>`),
      ...(provider ? [] : item.variantOptions ?? []).map(([name, value]) =>
        `      <g:variant_option><g:name>${escapeXml(name)}</g:name><g:value>${escapeXml(value)}</g:value></g:variant_option>`),
      "    </item>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    "  <channel>",
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(marketUrl)}</link>`,
    `    <description>GriipBuddy product offers for ${escapeXml(market.name)}</description>`,
    ...itemXml,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
