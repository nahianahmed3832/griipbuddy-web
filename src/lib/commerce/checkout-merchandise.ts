import type { MarketId } from "../../config/markets.ts";
import { variantQuantities } from "../cart/model.ts";
import { resolveCartVariantReferences } from "../cart/legacy-reference.ts";
import { catalogProduct, catalogVariantInclude, catalogVariantWhere, catalogVariants } from "../catalog/connected-public.ts";
import { personalizationAvailable } from "../catalog/personalization.ts";
import type { DbReader } from "../db/client.ts";
import { marketConfiguration, type MarketPaymentMethod } from "../market-config.ts";
import { marketplaceMode } from "../release-config.ts";
import { allocateMinor } from "./allocate-minor.ts";
import type { CheckoutQuote, NormalizedCheckout, QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { marketStock } from "./location-inventory.ts";
import { inventoryPoolScopeKey, marketInventoryAvailability, type InventoryDestination } from "./physical-inventory.ts";
import { pilotCheckoutScope } from "./scoped-pilot-checkout.ts";

export async function quoteMerchandise(db: DbReader, input: {
  marketId: MarketId;
  paymentMethod: MarketPaymentMethod;
  destination: InventoryDestination;
  items: NormalizedCheckout["items"];
}): Promise<QuoteLine[]> {
  const { marketId, items } = input;
  const pilot = await pilotCheckoutScope(db, input);
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
  const sellerIds = [...new Set([...connected.map(offer => offer.ownerId),
    ...rows.flatMap(row => row.product.marketplaceShopId ? [row.product.marketplaceShopId] : [])])];
  const [origins, mappings, sellers, stock] = await Promise.all([
    originOffers.length ? db.marketOfferIdentity.findMany({
      where: { id: { in: originOffers } }, select: { id: true, marketId: true, variantId: true, sellerId: true },
    }) : [],
    resolveCartVariantReferences(originVariants, db),
    sellerIds.length ? db.marketplaceShop.findMany({
      where: { id: { in: sellerIds } }, select: { id: true, name: true },
    }) : [],
    connected.length ? marketInventoryAvailability(db, input, connected, pilot?.poolIds) : null,
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
    const marketplaceShopId = offer.id ? offer.sellerId : row.product.marketplaceShopId;
    return [{
      variantId, sku: variant.sku, productName: offer.id ? product.name : row.product.name, variantName: variant.label, quantity,
      unitPriceMinor: offer.regularMinor, unitDiscountMinor: offer.regularMinor - offer.amountMinor,
      lineTotalMinor: offer.amountMinor * quantity,
      productIdSnapshot: product.id,
      ...(marketplaceShopId && { marketplaceShopId, marketplaceShopNameSnapshot: sellerNames.get(marketplaceShopId) }),
      ...(personalization && { personalization }),
      ...(cartVariantId && cartVariantId !== variantId && { cartVariantIdSnapshot: cartVariantId }),
      ...(offer.id ? {
        offerIdSnapshot: offer.id, offerRevision: offer.revision,
        optionsSnapshot: variant.options.map(option => ({ name: option.label, value: option.valueLabel })),
        ...(variant.image && { imageSrcSnapshot: variant.image.src, imageAltSnapshot: variant.image.alt }),
        ...(cartOfferId && { cartOfferIdSnapshot: cartOfferId }),
      } : {}),
    }];
  });
  if (issues.size) throw new CommerceError({ kind: "unavailable",
    message: "Review your cart. Some items or quantities are unavailable for this checkout.", issues: [...issues] });
  return lines;
}

export function allocateCheckoutLines(quote: Pick<CheckoutQuote,
  "lines" | "subtotalMinor" | "discountMinor" | "deliveryMinor" | "taxMinor" | "totalMinor">) {
  const weights = quote.lines.map(line => line.lineTotalMinor);
  const merchandise = weights.reduce((sum, weight) => sum + weight, 0);
  if (!quote.lines.length || merchandise !== quote.subtotalMinor - quote.discountMinor ||
      merchandise + quote.deliveryMinor + quote.taxMinor !== quote.totalMinor ||
      (merchandise === 0 && quote.taxMinor > 0)) throw new Error("The order totals cannot be reconciled to its lines.");
  const delivery = allocateMinor(quote.deliveryMinor, merchandise ? weights : quote.lines.map(line => line.quantity));
  const tax = allocateMinor(quote.taxMinor, weights);
  return quote.lines.map(({ offerRevision, ...line }, index) => ({
    ...line, pricedOfferRevision: offerRevision, deliveryAllocatedMinor: delivery[index], taxAllocatedMinor: tax[index],
  }));
}
