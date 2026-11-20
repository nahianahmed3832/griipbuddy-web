import type { MarketId } from "../../config/markets.ts";
import { variantQuantities } from "../cart/model.ts";
import { resolveCartVariantReferences } from "../cart/legacy-reference.ts";
import { catalogProduct, catalogVariantInclude, catalogVariantWhere, catalogVariants } from "../catalog/connected-public.ts";
import { personalizationAvailable } from "../catalog/personalization.ts";
import type { DbReader } from "../db/client.ts";
import { marketConfiguration, type MarketPaymentMethod } from "../market-config.ts";
import { marketplaceMode } from "../release-config.ts";
import type { NormalizedCheckout, QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { marketStock } from "./location-inventory.ts";
import { inventoryPoolScopeKey, marketInventoryAvailability, type InventoryDestination } from "./physical-inventory.ts";

export async function quoteMerchandise(db: DbReader, input: {
  marketId: MarketId;
  paymentMethod: MarketPaymentMethod;
  destination: InventoryDestination;
  items: NormalizedCheckout["items"];
}): Promise<QuoteLine[]> {
  const { marketId, items } = input;
  const market = marketConfiguration(marketId);
  const context = { marketId, locale: market.defaultLocale };
  const requested = variantQuantities(items);
  const variantFields = catalogVariantInclude(context);
  const rows = await db.variant.findMany({
    where: { ...catalogVariantWhere(marketId), id: { in: [...requested.keys()] } },
    include: { ...variantFields, product: { select: {
      ...variantFields.product.select, personalizationPrompt: true, personalizationRequired: true,
    } } },
  });
  const variants = new Map((await catalogVariants(rows, context, db)).map(variant => [variant.id, variant]));
  const byId = new Map(rows.map(row => [row.id, row]));
  const originOffers = [...new Set(items.flatMap(item => item.cartOfferId ? [item.cartOfferId] : []))];
  const originVariants = [...new Set(items.flatMap(item => item.cartVariantId && item.cartVariantId !== item.variantId ? [item.cartVariantId] : []))];
  const connected = [...variants.values()].flatMap(({ id, offer }) => offer.id && offer.eligible ? [{ variantId: id, ownerId: offer.sellerId }] : []);
  const [origins, mappings, sellers, stock] = await Promise.all([
    originOffers.length ? db.marketOfferIdentity.findMany({
      where: { id: { in: originOffers } }, select: { id: true, marketId: true, variantId: true, sellerId: true },
    }) : [],
    resolveCartVariantReferences(originVariants, db),
    connected.length ? db.marketplaceShop.findMany({
      where: { id: { in: [...new Set(connected.map(offer => offer.ownerId))] } }, select: { id: true, name: true },
    }) : [],
    connected.length ? marketInventoryAvailability(db, input, connected) : null,
  ]);
  const offersById = new Map(origins.map(offer => [offer.id, offer]));
  const sellerNames = new Map(sellers.map(seller => [seller.id, seller.name]));
  const issues = new Set<string>();
  const lines = items.flatMap(({ variantId, offerId, cartOfferId, cartVariantId, quantity, personalization }) => {
    const row = byId.get(variantId);
    const variant = variants.get(variantId);
    if (!row || !variant) {
      issues.add("An item in your cart is no longer available in this market.");
      return [];
    }
    const { offer } = variant;
    const product = catalogProduct(row.product, context);
    const title = `${product.name} (${variant.label})`;
    const origin = cartOfferId && offersById.get(cartOfferId);
    const mapped = !cartVariantId || cartVariantId === variantId || mappings.get(cartVariantId) === variantId;
    if (offer.id !== (offerId ?? null) || !offer.eligible || !mapped || (cartOfferId && (!offer.id || !origin ||
      origin.variantId !== variantId || origin.sellerId !== offer.sellerId || (origin.marketId === marketId && origin.id !== offer.id)))) {
      issues.add(`${title}: review its exact offer in your cart.`);
      return [];
    }
    const available = offer.id
      ? stock?.poolsByOffer.get(inventoryPoolScopeKey({ variantId, ownerId: offer.sellerId }))?.available
      : marketStock(row, marketId, row.product.marketplaceShopId);
    if (available === undefined || available < (requested.get(variantId) ?? quantity)) {
      issues.add(available === undefined ? `${title}: delivery is unavailable for this destination.`
        : `${title}: ${available} available, ${requested.get(variantId) ?? quantity} requested.`);
      return [];
    }
    const { personalizationPrompt, personalizationRequired } = row.product;
    const settings = (marketplaceMode() || input.paymentMethod === "PAYPAL") && personalizationPrompt
      ? { prompt: personalizationPrompt, required: personalizationRequired } : undefined;
    if (!personalizationAvailable(settings, personalization)) {
      issues.add(`${title}: review its personalization instructions.`);
      return [];
    }
    return [{
      variantId, sku: variant.sku, productName: offer.id ? product.name : row.product.name, variantName: variant.label, quantity,
      unitPriceMinor: offer.regularMinor, unitDiscountMinor: offer.regularMinor - offer.amountMinor,
      lineTotalMinor: offer.amountMinor * quantity,
      ...(personalization && { personalization }),
      ...(cartVariantId && cartVariantId !== variantId && { cartVariantIdSnapshot: cartVariantId }),
      ...(offer.id ? {
        productIdSnapshot: product.id, offerIdSnapshot: offer.id, offerRevision: offer.revision,
        marketplaceShopId: offer.sellerId, marketplaceShopNameSnapshot: sellerNames.get(offer.sellerId),
        optionsSnapshot: variant.options.map(option => ({ name: option.label, value: option.valueLabel })),
        ...(variant.image && { imageSrcSnapshot: variant.image.src, imageAltSnapshot: variant.image.alt }),
        ...(cartOfferId && { cartOfferIdSnapshot: cartOfferId }),
      } : row.product.marketplaceShopId ? { marketplaceShopId: row.product.marketplaceShopId } : {}),
    }];
  });
  if (issues.size) throw new CommerceError({ kind: "unavailable",
    message: "Review your cart. Some items or quantities are unavailable for this checkout.", issues: [...issues] });
  return lines;
}

export function checkoutOrderLine({ offerRevision: _revision, ...line }: QuoteLine) {
  void _revision;
  return line;
}
