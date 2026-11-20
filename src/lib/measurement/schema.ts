import { z } from "zod";
import { isMarketId, marketList, markets, type Currency, type MarketId } from "../../config/markets.ts";
import { acquisitionCampaign, campaignSources } from "./campaign.ts";
import { safeSearchQuery } from "./search-privacy.ts";

export const measurementSchemaVersion = 1;

export const browserMeasurementKinds = [
  "PRODUCT_IMPRESSION", "HOMEPAGE_SECTION_IMPRESSION", "PRODUCT_CLICK", "PRODUCT_VIEW",
  "CATEGORY_IMPRESSION", "CATEGORY_CLICK", "CATEGORY_FILTER", "VARIANT_SELECTION",
  "SEARCH", "SEARCH_FILTER", "WISHLIST_ADD", "WISHLIST_REMOVE", "CART_ADD", "CART_UPDATE", "CART_REMOVE",
  "CHECKOUT_START", "CHECKOUT_STEP", "CHECKOUT_FAILURE", "ACCOUNT_ASSOCIATED", "EXPERIMENT_EXPOSURE",
] as const;

export const commerceOutcomeKinds = [
  "ORDER_ACCEPTED", "PAYMENT_PAID", "PAYMENT_FAILED", "ORDER_DELIVERED", "ORDER_REFUSED", "COD_COLLECTED",
  "COD_REMITTED", "ORDER_CANCELLED", "RETURN_REQUESTED", "RETURN_RECEIVED", "ORDER_REFUNDED",
] as const;

export type CommerceOutcomeKind = typeof commerceOutcomeKinds[number];

const checkoutSteps = ["ADDRESS", "DELIVERY_PAYMENT", "REVIEW", "SUBMIT", "PROVIDER_REDIRECT", "RECOVERY", "HANDOFF"] as const;
const checkoutFailures = ["VALIDATION", "NETWORK", "UNAVAILABLE", "REJECTED", "CANCELLED"] as const;
export type CheckoutStep = typeof checkoutSteps[number];
export type CheckoutFailure = typeof checkoutFailures[number];

const minorAmount = z.int().min(0).max(2_147_483_647);
const label = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const catalogId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const sort = z.enum(["recommended", "newest", "price-low", "price-high", "name"]);
const categoryFilterFields = ["brand", "model", "design", "color", "size", "option", "attribute", "price", "availability", "sale"] as const;
const categoryFilters = z.strictObject({
  fields: z.array(z.enum(categoryFilterFields)).max(categoryFilterFields.length)
    .refine(fields => fields.length === new Set(fields).size),
  sort: sort.optional(),
});
export type CategoryFilterField = typeof categoryFilterFields[number];
export type CategoryMeasurementSort = z.input<typeof sort>;

const filters = z.strictObject({
  department: label.optional(),
  color: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u).optional(),
  device: label.optional(),
  availability: z.literal("in-stock").optional(),
  offer: z.literal("sale").optional(),
  min: minorAmount.optional(),
  max: minorAmount.optional(),
  shop: label.optional(),
  sort: sort.optional(),
});
export type MeasurementFilters = z.input<typeof filters>;

export const browserMeasurementSchema = z.strictObject({
  version: z.literal(measurementSchemaVersion),
  nonce: z.uuidv4(),
  sessionId: z.uuidv4(),
  at: z.iso.datetime(),
  action: z.enum(browserMeasurementKinds),
  marketId: z.custom<MarketId>(isMarketId),
  categoryId: catalogId.optional(),
  productId: catalogId.optional(),
  variantId: catalogId.optional(),
  offerId: z.uuid().optional(),
  quantity: z.int().min(1).max(10_000).optional(),
  displayedPriceMinor: minorAmount.optional(),
  currency: z.custom<Currency>(value => marketList.some(market => market.currency === value)).optional(),
  placement: label.optional(),
  position: z.int().min(1).max(2_147_483_647).optional(),
  homepageConfig: label.optional(),
  sectionId: z.string().regex(/^[a-z][a-z0-9-]{0,38}$/).optional(),
  experimentAssignment: label.optional(),
  recommendationVersion: label.optional(),
  query: z.string().max(100).transform(safeSearchQuery).optional(),
  searchStage: z.enum(["submitted", "model-suggestion"]).optional(),
  resultCount: z.int().min(0).max(2_147_483_647).optional(),
  filters: filters.optional(),
  categoryFilters: categoryFilters.optional(),
  step: z.enum(checkoutSteps).optional(),
  failureCode: z.enum(checkoutFailures).optional(),
  campaignSource: z.enum(campaignSources).optional(),
  campaign: z.strictObject({
    utm_source: z.literal(acquisitionCampaign.utm.utm_source),
    utm_medium: z.literal(acquisitionCampaign.utm.utm_medium),
    utm_campaign: z.literal(acquisitionCampaign.utm.utm_campaign),
    utm_content: z.literal(acquisitionCampaign.utm.utm_content),
  }).optional(),
}).refine(event => {
  const { action, categoryId, currency, displayedPriceMinor, marketId, productId, variantId, offerId, resultCount, step, failureCode } = event;
  if (currency !== undefined && (displayedPriceMinor === undefined || currency !== markets[marketId].currency)) return false;
  if (displayedPriceMinor !== undefined && currency === undefined) return false;
  const catalogCard = action === "PRODUCT_IMPRESSION" || action === "PRODUCT_CLICK";
  if (event.sectionId && (!event.homepageConfig || !event.placement ||
      !catalogCard && action !== "HOMEPAGE_SECTION_IMPRESSION" && action !== "EXPERIMENT_EXPOSURE")) return false;
  const searchCard = catalogCard && (event.placement === "search-results" || event.placement === "search-suggestion");
  if (offerId && (!variantId || !searchCard && !["PRODUCT_VIEW", "VARIANT_SELECTION", "CART_ADD", "CART_UPDATE", "CART_REMOVE",
    "CHECKOUT_START", "CHECKOUT_STEP", "CHECKOUT_FAILURE"].includes(action))) return false;
  if (event.categoryFilters && action !== "CATEGORY_FILTER" && !(action === "SEARCH_FILTER" && event.placement === "search-results")) return false;
  if (event.searchStage && (action !== "SEARCH" || resultCount !== undefined || event.query || event.filters || productId || variantId ||
    categoryId || displayedPriceMinor !== undefined || event.quantity !== undefined || event.placement !==
      (event.searchStage === "submitted" ? "search-box" : "search-model-suggestion"))) return false;
  if (event.placement === "category-grid" && (!categoryId || !productId || !catalogCard)) return false;
  if (action === "CATEGORY_IMPRESSION" || action === "CATEGORY_CLICK" || action === "CATEGORY_FILTER") {
    if (!categoryId || productId || variantId || displayedPriceMinor !== undefined || event.query || event.filters || event.quantity !== undefined) {
      return false;
    }
    if (action === "CATEGORY_CLICK") {
      return resultCount === undefined && (event.placement === "category-children" || event.placement === "category-navigation" ||
        event.placement === "search-category-suggestion");
    }
    return resultCount !== undefined && event.placement === "category-listing" &&
      (action === "CATEGORY_IMPRESSION" || Boolean(event.categoryFilters));
  }
  if (categoryId && (!catalogCard || event.placement !== "category-grid")) return false;
  switch (action) {
    case "EXPERIMENT_EXPOSURE":
      return Boolean(event.placement && event.experimentAssignment && event.recommendationVersion);
    case "PRODUCT_VIEW":
      return Boolean(variantId);
    case "VARIANT_SELECTION":
      return Boolean(productId && variantId);
    case "PRODUCT_IMPRESSION":
    case "PRODUCT_CLICK":
    case "WISHLIST_ADD":
    case "WISHLIST_REMOVE":
      return Boolean(productId || variantId);
    case "CART_ADD":
    case "CART_UPDATE":
    case "CART_REMOVE":
      return Boolean(variantId);
    case "HOMEPAGE_SECTION_IMPRESSION":
      return Boolean(event.homepageConfig && event.placement && event.position);
    case "SEARCH":
      return Boolean(event.searchStage) || resultCount !== undefined;
    case "SEARCH_FILTER":
      return resultCount !== undefined;
    case "CHECKOUT_STEP":
      return Boolean(step && !failureCode);
    case "CHECKOUT_FAILURE":
      return Boolean(step && failureCode);
    default:
      return true;
  }
}, "Event fields do not match the event type or market.");

export type BrowserMeasurement = z.input<typeof browserMeasurementSchema>;
