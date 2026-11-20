import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { catalogProduct, catalogVariantInclude, catalogVariants, catalogVariantWhere } from "../catalog/connected-public.ts";
import { catalog } from "../catalog/repository.ts";
import type { CartCatalogItem } from "../catalog/types.ts";
import { contiguousStates } from "../commerce/address.ts";
import { integratedCheckout } from "../commerce/integrated-checkout.ts";
import { legacyLocationId } from "../commerce/location-inventory.ts";
import { deliveryChoices } from "../commerce/orders.ts";
import { paypalCheckoutAvailability } from "../commerce/paypal-config.ts";
import { inventoryPoolScopeKey } from "../commerce/physical-inventory.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { marketplaceMode } from "../release-config.ts";
import { resolveCartVariantReferences } from "./legacy-reference.ts";
import { cartOfferKey, MAX_QUANTITY, type CartItemReference } from "./model.ts";

type CartMarket = { id: MarketId; locale: string };
type OwnerVariant = { variantId: string; ownerId: string };

async function purchaseDestinations(marketId: MarketId, db: DbReader) {
  const market = marketConfiguration(marketId);
  if (market.checkoutAuthority !== "native" || integratedCheckout(marketId)) return [];
  const [cod, prepaid] = await Promise.all([deliveryChoices(marketId, "COD", db), deliveryChoices(marketId, "SSLCOMMERZ", db)]);
  const destinations = [...cod, ...prepaid].map(({ district, method }) => ({ district, method }));
  if (!paypalCheckoutAvailability(marketId).paymentEnabled) return destinations;
  if (market.pricing.taxTreatment === "MERCHANDISE_RATE") {
    const policy = await db.checkoutPolicy.findUnique({ where: { marketId } });
    if (!policy?.enabled || policy.countryCode !== market.countryCode || policy.currency !== market.currency ||
        policy.taxTreatment !== market.pricing.taxTreatment || policy.taxBasisPoints === null ||
        policy.taxBasisPoints < 0 || policy.taxBasisPoints > 10_000 || !policy.taxLabel?.trim()) return destinations;
  }
  return [...destinations, ...[...contiguousStates].map(district => ({ district: district.toLowerCase(), method: "sandbox-standard" }))];
}

// The cart may lack an address. Report the maximum routable stock for a single
// configured destination and check the chosen destination again in checkout.
async function cartStock(marketId: MarketId, offers: readonly OwnerVariant[], db: DbReader) {
  if (!offers.length) return new Map<string, number>();
  const destinations = await purchaseDestinations(marketId, db);
  if (!destinations.length) return new Map<string, number>();
  const choices = new Map(destinations.map(destination => [`${destination.district}:${destination.method}`, destination]));
  const byOwner = new Map<string, string[]>();
  for (const { variantId, ownerId } of offers) {
    byOwner.set(ownerId, [...(byOwner.get(ownerId) ?? []), variantId]);
  }
  const routeScope = { marketId, active: true } satisfies Prisma.DispatchLocationMarketWhereInput;
  const pools = await db.inventoryPool.findMany({
    where: { variant: { managedInventory: true }, OR: [...byOwner].map(([ownerId, variants]) => ({
      ownerId, variantId: { in: variants }, location: {
        id: { not: legacyLocationId }, active: true, marketServices: { some: routeScope },
        ...(ownerId === storeShop.id ? { OR: [{ shopId: null }, { shopId: ownerId }] } : { shopId: ownerId }),
      },
    })) },
    select: {
      ownerId: true, variantId: true, onHand: true, reserved: true,
      location: { select: { marketServices: { where: routeScope, select: { districts: true, methods: true } } } },
    },
  });
  const availability = new Map<string, Map<string, number>>();
  for (const pool of pools) {
    const key = inventoryPoolScopeKey(pool);
    const stock = availability.get(key) ?? new Map<string, number>();
    for (const [destination, { district, method }] of choices) {
      if (!pool.location.marketServices.some(route =>
        (!route.districts.length || route.districts.includes(district)) && (!route.methods.length || route.methods.includes(method)))) continue;
      stock.set(destination, (stock.get(destination) ?? 0) + pool.onHand - pool.reserved);
    }
    if (stock.size) availability.set(key, stock);
  }
  return new Map([...availability].map(([key, stock]) => [key, Math.min(MAX_QUANTITY, Math.max(0, ...stock.values()))]));
}

export async function resolveCartCatalog(references: readonly CartItemReference[], { id: marketId, locale }: CartMarket,
  reader?: DbReader) {
  if (!references.length) return [];
  const lines = [...new Map(references.map(line => [cartOfferKey(line), line])).values()];
  const legacyIds = lines.flatMap(({ variantId, offerId }) => offerId ? [] : [variantId]);
  async function read(tx: DbReader) {
    // Recovered checkout remains the source of truth while its writer owns the market.
    const resolved = integratedCheckout(marketId) ? new Map(legacyIds.map(id => [id, id]))
      : await resolveCartVariantReferences(legacyIds, tx);
    const requested = [...new Set(lines.flatMap(({ variantId, offerId }) =>
      offerId ? [variantId] : resolved.has(variantId) ? [resolved.get(variantId)!] : []))];
    const context = { marketId, locale };
    const include = catalogVariantInclude(context);
    const [rows, sources] = await Promise.all([
      tx.variant.findMany({ where: { id: { in: requested }, ...catalogVariantWhere(marketId),
        offers: { some: { marketId, offerId: { not: null } } },
      }, include: { ...include, product: { select: { ...include.product.select, personalizationPrompt: true, personalizationRequired: true } } } }),
      tx.marketOfferIdentity.findMany({ where: { id: { in: lines.flatMap(line => line.offerId ? [line.offerId] : []) } },
        select: { id: true, variantId: true, marketId: true, sellerId: true } }),
    ]);
    const variants = await catalogVariants(rows, context, tx);
    const stock = await cartStock(marketId, variants.flatMap(({ id, offer }) => offer.eligible
      ? [{ variantId: id, ownerId: offer.sellerId }] : []), tx);
    const visible = new Map(rows.map(row => [row.id, {
      ...catalogProduct(row.product, context), personalization: marketplaceMode() && row.product.personalizationPrompt
        ? { prompt: row.product.personalizationPrompt, required: row.product.personalizationRequired } : undefined,
    }]));
    const projected = new Map(variants.map(variant => [variant.id, variant]));
    const bySource = new Map(sources.map(source => [source.id, source]));
    const connected = new Map<string, CartCatalogItem>();
    for (const line of lines) {
      const id = line.offerId ? line.variantId : resolved.get(line.variantId);
      if (!id) continue;
      const product = visible.get(id);
      const variant = projected.get(id);
      if (!product || !variant) continue;
      const { offer } = variant;
      const offerId = offer.id;
      if (!offerId) continue;
      const source = line.offerId ? bySource.get(line.offerId) : undefined;
      const changed = Boolean(line.offerId && !(source?.variantId === id &&
        (source.id === offerId || source.marketId !== marketId && source.sellerId === offer.sellerId)));
      const available = stock.get(inventoryPoolScopeKey({ variantId: id, ownerId: offer.sellerId }));
      connected.set(cartOfferKey(line), {
        variantId: id, productId: product.id, slug: product.slug, name: product.name, variantLabel: variant.label, sku: variant.sku,
        selectedOptions: variant.options.map(({ label, valueLabel }) => ({ label, value: valueLabel })),
        personalization: product.personalization,
        image: variant.image ?? { src: "/editorial/hero.webp", alt: product.name },
        requestedVariantId: line.variantId, requestedOfferId: line.offerId,
        offer: !changed && offer.eligible && available !== undefined ? { id: offerId, variantId: id, marketId, currency: offer.currency,
          amountMinor: offer.amountMinor, regularMinor: offer.regularMinor, stock: available,
        } : null,
        ...(changed ? { offerIssue: "changed" as const } : !offer.eligible || available === undefined ? { offerIssue: "ineligible" as const } : {}),
      });
    }
    return { resolved, connected };
  }
  const { resolved, connected } = reader ? await read(reader)
    : await getDb().$transaction(read, { isolationLevel: "RepeatableRead" });

  const outstanding = lines.flatMap(line => {
    const target = resolved.get(line.variantId);
    return target && !line.offerId && !connected.has(cartOfferKey(line)) ? [target] : [];
  });
  // The existing legacy lookup also supports its configured recovered inventory bridge.
  const legacy = new Map((outstanding.length ? await catalog.resolveVariants([...new Set(outstanding)], marketId) : [])
    .map(item => [item.variantId, item]));
  return lines.flatMap(line => {
    const current = connected.get(cartOfferKey(line));
    if (current) return [current];
    const target = !line.offerId && resolved.get(line.variantId);
    const item = target ? legacy.get(target) : undefined;
    return item ? [{ ...item, ...(line.variantId !== target && { requestedVariantId: line.variantId }) }] : [];
  });
}
