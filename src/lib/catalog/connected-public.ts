import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { MAX_QUANTITY } from "../cart/model.ts";
import { integratedCheckout } from "../commerce/integrated-checkout.ts";
import { dispatchStockRelations, marketStock } from "../commerce/location-inventory.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import {
  inventoryDestinationInput, inventoryPoolScopeKey, marketInventoryAvailability, type InventoryDestination,
} from "../commerce/physical-inventory.ts";
import type { DbReader } from "../db/client.ts";
import { privateHeaders } from "../db/http.ts";
import { reportFailure } from "../db/observability.ts";
import { isMarketSelectable, marketConfiguration, marketLanguage, resolveMarketLocale, type MarketPaymentMethod } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { merchantProductEligibility } from "../marketplace/market-grants.ts";
import { catalogLocaleChain } from "./category-presentation.ts";
import { activeDiscount } from "./offer-price.ts";
import { catalogGalleryOrder, selectProductContent } from "./product-presentation.ts";
import { eligibleOffer, marketImage } from "./repository.ts";

export type CatalogReadContext = {
  marketId: MarketId;
  locale: string;
  delivery?: { destination: InventoryDestination; paymentMethod: MarketPaymentMethod; quantity: number };
};

export class CatalogApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CatalogApiError";
  }
}

const deliveryKeys = ["country", "district", "method", "postalCode", "paymentMethod", "quantity"] as const;
const deliveryInput = z.strictObject({
  destination: inventoryDestinationInput,
  paymentMethod: z.enum(["COD", "PAYPAL", "SSLCOMMERZ"]),
  quantity: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.int().max(MAX_QUANTITY)).optional(),
});
const catalogHeaders = { ...privateHeaders, Vary: "Cookie, Accept-Language" };

function takeParameter(params: URLSearchParams, key: string) {
  const values = params.getAll(key);
  if (values.length > 1) throw new CatalogApiError(400, "invalid_context", `Supply one ${key} value.`);
  params.delete(key);
  return values[0];
}

export function catalogDelivery(params: URLSearchParams): CatalogReadContext["delivery"] {
  if (!deliveryKeys.some(key => params.has(key))) return;
  const [country, district, method, postalCode, paymentMethod, quantity] = deliveryKeys.map(key => takeParameter(params, key));
  const parsed = deliveryInput.safeParse({ destination: { country, district, method, postalCode }, paymentMethod, quantity });
  if (!parsed.success) throw new CatalogApiError(400, "invalid_destination", "Supply a country, district, delivery method and payment method.");
  return { ...parsed.data, quantity: parsed.data.quantity ?? 1 };
}

export async function catalogRequest(request: Request, read: (params: URLSearchParams, context: CatalogReadContext) => Promise<unknown>) {
  try {
    const params = new URL(request.url).searchParams;
    const requestedMarket = takeParameter(params, "market");
    const requestedLanguage = takeParameter(params, "lang");
    if (requestedMarket !== undefined && !isMarketSelectable(requestedMarket)) {
      throw new CatalogApiError(400, "invalid_market", "Choose a browsable market.");
    }
    const delivery = catalogDelivery(params);
    const { currentMarket } = await import("../market-server.ts");
    const current = await currentMarket();
    const marketId = requestedMarket ?? current.id;
    const market = marketConfiguration(marketId);
    if (requestedLanguage !== undefined && !marketLanguage(market, requestedLanguage)) {
      throw new CatalogApiError(400, "invalid_locale", "Choose a supported language for this market.");
    }
    const locale = resolveMarketLocale(market, requestedLanguage ?? (marketId === current.id ? current.locale : undefined),
      request.headers.get("accept-language"));
    const data = await read(params, { marketId, locale, delivery });
    return Response.json(data, { headers: catalogHeaders });
  } catch (error) {
    if (error instanceof CatalogApiError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: catalogHeaders });
    }
    reportFailure("catalog.read", undefined, error);
    return Response.json({ error: { code: "catalog_unavailable", message: "The catalog is temporarily unavailable." } },
      { status: 503, headers: catalogHeaders });
  }
}

function publicLegacyOffer(marketId: MarketId) {
  return { ...eligibleOffer(marketId), publication: "ACTIVE" } as const;
}

export function catalogVariantWhere(marketId: MarketId, purchasable = false): Prisma.VariantWhereInput {
  return {
    active: true, archivedAt: null, product: { active: true, publication: "ACTIVE" },
    OR: [
      { offers: { some: purchasable ? { ...connectedOfferScope(marketId), eligible: true } : connectedOfferScope(marketId) } },
      { managedInventory: false, product: merchantProductEligibility(marketId), offers: { some: publicLegacyOffer(marketId) } },
    ],
  };
}

const imageFields = { src: true, alt: true, position: true, isPrimary: true } as const;
const optionFields = { id: true, key: true, label: true, position: true, values: {
  orderBy: [{ position: "asc" }, { id: "asc" }],
  select: { id: true, value: true, label: true },
} } as const satisfies Prisma.ProductOptionSelect;

function catalogProductSelect(locale: string) {
  return {
    id: true, slug: true, brand: true, name: true, description: true, shortDescription: true, departmentId: true,
    addedOn: true, position: true, specifications: true, attributeValues: true, keywords: true, marketplaceShopId: true,
    personalizationPrompt: true, personalizationRequired: true,
    translations: { where: { locale: { in: catalogLocaleChain(locale) } },
      select: { locale: true, name: true, description: true, shortDescription: true } },
    secondaryCategories: { orderBy: { departmentId: "asc" }, select: { departmentId: true } },
    images: { select: imageFields },
    optionDefinitions: { orderBy: [{ position: "asc" }, { id: "asc" }], select: optionFields },
  } as const satisfies Prisma.ProductSelect;
}

export function catalogVariantInclude(context: CatalogReadContext) {
  const { marketId } = context;
  return {
    ...dispatchStockRelations,
    product: { select: catalogProductSelect(context.locale) },
    offers: { where: { OR: [connectedOfferScope(marketId), publicLegacyOffer(marketId)] },
      include: { identity: { select: { id: true, sellerId: true } } } },
    images: { select: imageFields },
    optionSelections: { select: { optionId: true, optionValueId: true } },
    compatibility: { orderBy: { modelId: "asc" }, select: { model: { select: {
      id: true, name: true, brand: true, aliases: { orderBy: { lookupKey: "asc" }, select: { label: true } },
    } } } },
  } as const satisfies Prisma.VariantInclude;
}

export type CatalogVariantRow = Prisma.VariantGetPayload<{ include: ReturnType<typeof catalogVariantInclude> }>;

export function typedCatalogAttributes(value: Prisma.JsonValue | null) {
  const attributes: Record<string, string | number | boolean> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number") {
        Object.defineProperty(attributes, key, { value: entry, enumerable: true });
      }
    }
  }
  return attributes;
}

function marketGallery(rows: CatalogVariantRow["images"], marketId: MarketId) {
  return catalogGalleryOrder(rows).map(({ src, alt }) => ({ src: marketImage(src, marketId), alt }));
}

const publicSpecifications = z.array(z.object({ label: z.string(), value: z.string() }));

export function catalogProduct(product: CatalogVariantRow["product"], context: CatalogReadContext) {
  const content = selectProductContent(product, product.translations, context.locale);
  return {
    id: product.id, slug: product.slug, ...content, shortDescription: content.shortDescription ?? null,
    brand: product.brand, primaryCategoryId: product.departmentId,
    secondaryCategoryIds: product.secondaryCategories.map(category => category.departmentId),
    specifications: publicSpecifications.safeParse(product.specifications).data ?? [],
    attributes: typedCatalogAttributes(product.attributeValues),
    images: marketGallery(product.images, context.marketId),
  };
}

function optionKey(value: string) {
  return value.trim().toLowerCase();
}

function publicOptions(row: CatalogVariantRow) {
  if (row.optionSignature !== null) {
    const selections = new Map(row.optionSelections.map(item => [item.optionId, item.optionValueId]));
    return row.product.optionDefinitions.flatMap(option => {
      const value = option.values.find(item => item.id === selections.get(option.id));
      return value ? [{ key: option.key, label: option.label, value: value.value, valueLabel: value.label,
        optionId: option.id, valueId: value.id }] : [];
    });
  }
  return Object.entries(typedCatalogAttributes(row.options)).flatMap(([label, value]) =>
    typeof value === "string" ? [{ key: optionKey(label), label, value, valueLabel: value, optionId: null, valueId: null }] : []);
}

export type CatalogAvailability = "available" | "out_of_stock" | "delivery_unavailable" | "browse_only";

export async function catalogVariants(rows: CatalogVariantRow[], context: CatalogReadContext, db: DbReader, now = new Date(),
  options?: { browseLegacyStock?: boolean; includeQuantityLimit?: boolean }) {
  const { marketId, delivery } = context;
  const market = marketConfiguration(marketId);
  const entries = rows.flatMap(row => {
    const offer = row.offers[0];
    if (!offer) return [];
    const sellerId = offer.identity?.sellerId ?? row.product.marketplaceShopId ?? storeShop.id;
    return [{ row, offer, sellerId, eligible: offer.eligible && market.status !== "paused" }];
  });
  const inventory = delivery && entries.some(entry => entry.eligible)
    ? await marketInventoryAvailability(db, { ...delivery, marketId }, entries.flatMap(({ row, offer, sellerId, eligible }) =>
      offer.identity && eligible ? [{ variantId: row.id, ownerId: sellerId }] : []))
    : undefined;
  const recovered = integratedCheckout(marketId);
  return entries.map(({ row, offer, sellerId, eligible }) => {
    let availability: CatalogAvailability = "browse_only";
    let quantityLimit: number | undefined;
    if (delivery && eligible && !(recovered && !offer.identity)) {
      const pool = inventory?.poolsByOffer.get(inventoryPoolScopeKey({ variantId: row.id, ownerId: sellerId }));
      const count = offer.identity ? pool?.available : inventory?.acceptsDestination ? marketStock(row, marketId, sellerId) : undefined;
      availability = count === undefined ? "delivery_unavailable" : count >= delivery.quantity ? "available" : "out_of_stock";
      if (options?.includeQuantityLimit && count !== undefined) quantityLimit = Math.min(MAX_QUANTITY, count);
    } else if (!delivery && options?.browseLegacyStock && eligible && offer.offerId === null &&
      !row.managedInventory && !recovered && market.checkoutAuthority === "native" &&
      (row.locationInventory.length > 0 || market.catalog.inventory === "shared-legacy" && row.inventory)) {
      // Legacy listing filters can use native stock evidence before delivery selection.
      availability = marketStock(row, marketId, sellerId) > 0 ? "available" : "out_of_stock";
    }
    const gallery = marketGallery(row.images, marketId);
    const legacyImage = row.imageSrc && row.imageAlt ? { src: marketImage(row.imageSrc, marketId), alt: row.imageAlt } : null;
    const image = gallery[0] ?? legacyImage ?? marketGallery(row.product.images, marketId)[0] ?? null;
    const discount = activeDiscount(offer, now);
    return {
      id: row.id, sku: row.sku, label: row.label, position: row.position, isDefault: row.isDefault,
      gtin: row.gtin, mpn: row.mpn,
      options: publicOptions(row), attributes: typedCatalogAttributes(row.attributeValues),
      compatibility: row.compatibility.map(({ model }) => ({
        id: model.id, name: model.name, brand: model.brand, aliases: model.aliases.map(alias => alias.label),
      })),
      gallery: gallery.length ? gallery : legacyImage ? [legacyImage] : [],
      image, availability, ...(quantityLimit !== undefined && { quantityLimit }),
      offer: { id: offer.identity?.id ?? null, variantId: row.id, marketId, sellerId, currency: markets[marketId].currency,
        amountMinor: offer.amountMinor - discount, regularMinor: offer.amountMinor, eligible, revision: offer.revision,
        promotionEndsAt: discount ? offer.discountEndsAt?.toISOString() ?? null : null },
    };
  });
}

export type PublicCatalogVariant = Awaited<ReturnType<typeof catalogVariants>>[number];
