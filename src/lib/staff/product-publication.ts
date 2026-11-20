import { z } from "zod";
import { marketIds, markets, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { categoryAttributes, validateCategoryAttributeValues } from "../catalog/category-attributes.ts";
import { variantOptionSignature } from "../catalog/option-signature.ts";
import { contiguousStates } from "../commerce/address.ts";
import { connectedSellerVisibility, type CommercialActor } from "../commerce/commercial-access.ts";
import { integratedCheckout } from "../commerce/integrated-checkout.ts";
import { legacyLocationId } from "../commerce/location-inventory.ts";
import { saveConnectedOffer } from "../commerce/market-offers.ts";
import { deliveryChoices } from "../commerce/orders.ts";
import { paypalCheckoutAvailability } from "../commerce/paypal-config.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable, marketConfiguration } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { productionMode } from "../release-config.ts";
import { catalogImage, productIdField } from "./catalog-input.ts";
import { lockCatalogProductQuoteRows } from "./catalog-locks.ts";
import { missingImage } from "./catalog-media.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { authorize, lockProductEdits } from "./operations.ts";
import { saveProductFoundation } from "./product-foundation.ts";
import { categoryPlacementScope, lockTaxonomy } from "./taxonomy-write.ts";

type PurchaseOffer = { variantId: string; sellerId: string; marketId: MarketId };
const publishInput = z.strictObject({
  productId: productIdField,
  revision: z.int().min(0).max(2_147_483_646),
  publication: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("ACTIVE"),
});

const image = { src: true, alt: true } as const;
const publicationFields = {
  id: true, foundation: true, departmentId: true, description: true, demo: true, revision: true,
  publication: true, attributeValues: true, sellerListingReviews: { take: 1, select: { marketId: true } },
  images: { select: image },
  secondaryCategories: { select: { departmentId: true } },
  optionDefinitions: { select: { id: true, key: true, values: { select: { id: true, value: true } } } },
  variants: {
    where: { active: true, archivedAt: null }, orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, sku: true, attributeValues: true, isDefault: true, optionSignature: true,
      imageSrc: true, imageAlt: true, images: { select: image },
      optionSelections: { select: { optionId: true, optionValueId: true } },
    },
  },
} as const satisfies Prisma.ProductSelect;
type PublicationProduct = Prisma.ProductGetPayload<{ select: typeof publicationFields }>;

function valueRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function configuredDestinations(db: DbReader, marketId: MarketId) {
  const config = marketConfiguration(marketId);
  if (config.checkoutAuthority !== "native" || integratedCheckout(marketId)) return [];
  const [cod, prepaid] = await Promise.all([deliveryChoices(marketId, "COD", db), deliveryChoices(marketId, "SSLCOMMERZ", db)]);
  const destinations = [...cod, ...prepaid].filter(row => row.chargeMinor >= 0)
    .map(({ district, method }) => ({ district, method }));
  if (!paypalCheckoutAvailability(marketId).paymentEnabled) return destinations;
  if (config.pricing.taxTreatment === "MERCHANDISE_RATE") {
    const policy = await db.checkoutPolicy.findUnique({ where: { marketId } });
    if (!policy?.enabled || policy.currency !== config.currency || policy.countryCode !== config.countryCode ||
      policy.taxTreatment !== config.pricing.taxTreatment || policy.taxBasisPoints === null ||
      policy.taxBasisPoints < 0 || policy.taxBasisPoints > 10_000 || !policy.taxLabel?.trim()) return destinations;
  }
  return [...destinations, ...[...contiguousStates].map(district => ({ district: district.toLowerCase(), method: "sandbox-standard" }))];
}

async function fulfilmentGaps(db: DbReader, offers: readonly PurchaseOffer[]) {
  const gaps: { offer: PurchaseOffer; message: string }[] = [];
  for (const marketId of new Set(offers.map(offer => offer.marketId))) {
    const market = offers.filter(offer => offer.marketId === marketId);
    const contextName = markets[marketId].name;
    const destinations = await configuredDestinations(db, marketId);
    if (!destinations.length) {
      gaps.push(...market.map(offer => ({ offer, message: `Configure payment and delivery in ${contextName}, or keep the offer browse-only.` })));
      continue;
    }
    const pools = await db.inventoryPool.findMany({
      where: {
        variantId: { in: market.map(offer => offer.variantId) },
        ownerId: { in: market.map(offer => offer.sellerId) },
        variant: { managedInventory: true },
        location: { active: true, id: { not: legacyLocationId }, marketServices: { some: { marketId, active: true } } },
      },
      select: { variantId: true, ownerId: true, location: { select: {
        shopId: true, marketServices: { where: { marketId, active: true }, select: { districts: true, methods: true } },
      } } },
    });
    for (const offer of market) {
      const routed = pools.some(pool => pool.variantId === offer.variantId && pool.ownerId === offer.sellerId &&
        (pool.location.shopId ?? storeShop.id) === offer.sellerId &&
        pool.location.marketServices.some(route => destinations.some(({ district, method }) =>
          (!route.districts.length || route.districts.includes(district)) && (!route.methods.length || route.methods.includes(method)))));
      if (!routed) gaps.push({ offer, message: `Enable a warehouse pool and service route in ${contextName}, or keep the offer browse-only.` });
    }
  }
  return gaps;
}

export function saveWorkspaceOffer(actor: CommercialActor, raw: unknown) {
  return saveConnectedOffer(actor, raw, async (db, offer) => {
    const [first] = await fulfilmentGaps(db, [offer]);
    if (first) throw new CatalogWriteError("invalid_input", first.message);
  });
}

async function activeOffers(db: DbReader, variants: string[]) {
  return db.marketOffer.findMany({
    where: {
      variantId: { in: variants }, publication: "ACTIVE", amountMinor: { gt: 0 },
      OR: marketIds.filter(isMarketSelectable).map(marketId => ({
        marketId, currency: markets[marketId].currency,
        identity: { is: { retiredAt: null, seller: connectedSellerVisibility(marketId) } },
      })),
    },
    select: { variantId: true, marketId: true, amountMinor: true, discountMinor: true, discountStartsAt: true,
      discountEndsAt: true, eligible: true, identity: { select: { sellerId: true } } },
  });
}

async function evaluatePublication(db: DbReader, product: PublicationProduct) {
  const issues: string[] = [];
  const { variants } = product;
  const placements = [product.departmentId, ...product.secondaryCategories.map(row => row.departmentId)];
  const [placementCount, templates, offers] = await Promise.all([
    db.department.count({ where: categoryPlacementScope(placements, false) }),
    categoryAttributes(product.departmentId, db),
    activeOffers(db, variants.map(row => row.id)),
  ]);
  if (placementCount !== placements.length) issues.push("Choose active primary and additional subcategories.");
  if (product.description.trim().length < 10) issues.push("Enter a product description with at least 10 characters.");
  if (productionMode() && product.demo) issues.push("Sample products require a test catalog.");
  if (!variants.length || variants.filter(row => row.isDefault).length !== 1) issues.push("Choose one active default variant.");
  const signatures = new Set<string>();
  const values = variants.map(variant => {
    const picks = Object.fromEntries(variant.optionSelections.map(row => [row.optionId, row.optionValueId]));
    const choices = Object.fromEntries(product.optionDefinitions.flatMap(option => {
      const value = option.values.find(value => value.id === picks[option.id]);
      return value ? [[option.key, value.value]] : [];
    }));
    const signature = variantOptionSignature(picks);
    if (variant.optionSignature !== signature || Object.keys(choices).length !== product.optionDefinitions.length ||
      Object.keys(picks).length !== product.optionDefinitions.length || signatures.has(signature)) {
      issues.push(`Review the option combination for ${variant.sku}.`);
    }
    signatures.add(signature);
    return { id: variant.id, values: valueRecord(variant.attributeValues), options: choices };
  });
  for (const issue of validateCategoryAttributeValues(templates, { productValues: valueRecord(product.attributeValues), variants: values })) {
    const template = templates.find(row => row.id === issue.attributeId);
    const field = template?.name ?? issue.attributeId;
    const row = variants.find(variant => variant.id === issue.variantId);
    issues.push(`${row ? row.sku + " · " : ""}${field} requires review (${issue.reason.replaceAll("_", " ")}).`);
  }

  const validImage = (value: unknown) => {
    const parsed = catalogImage.safeParse(value);
    return parsed.success && (!productionMode() || parsed.data.src.startsWith("/media/"));
  };
  const shared = product.images.filter(validImage);
  const imagePaths = new Set(shared.map(row => row.src));
  for (const variant of variants) {
    const gallery = [...variant.images, { src: variant.imageSrc, alt: variant.imageAlt }].filter(validImage);
    for (const entry of gallery) if (entry.src) imagePaths.add(entry.src);
    if (!shared.length && !gallery.length) issues.push(`Add an approved shared image or a variant image for ${variant.sku}.`);
  }
  if (await missingImage(db, imagePaths)) issues.push("Replace unavailable gallery assets before publishing.");
  const issued = offers.filter(offer => offer.identity && (offer.discountMinor === null
    ? !offer.discountStartsAt && !offer.discountEndsAt
    : offer.discountMinor > 0 && offer.discountMinor < offer.amountMinor && !!offer.discountStartsAt &&
      !!offer.discountEndsAt && offer.discountStartsAt < offer.discountEndsAt));
  for (const { id, sku } of variants) {
    if (!issued.some(offer => offer.variantId === id)) issues.push(`Publish an approved market offer for ${sku}.`);
  }
  const purchase = issued.flatMap(({ eligible, identity, variantId, marketId }) =>
    eligible && identity ? [{ variantId, marketId, sellerId: identity.sellerId }] : []);
  for (const { offer, message } of await fulfilmentGaps(db, purchase)) {
    issues.push(`${variants.find(row => row.id === offer.variantId)?.sku ?? offer.variantId} · ${message}`);
  }
  return { ready: issues.length === 0, issues: [...new Set(issues)] };
}

export async function productPublicationReadiness(db: DbReader, productId: string) {
  const product = await db.product.findUnique({ where: { id: productId }, select: publicationFields });
  return product?.foundation && product.publication !== "ARCHIVED" ? evaluatePublication(db, product) : null;
}

function requirePublicationReadiness(readiness: Awaited<ReturnType<typeof evaluatePublication>>) {
  if (!readiness.ready) throw new CatalogWriteError("invalid_input", readiness.issues[0],
    readiness.issues.slice(0, 12).map(message => ({ path: "publication", message })));
}

export function saveWorkspaceProduct(actorId: string, input: unknown) {
  return saveProductFoundation(actorId, input, async (db, id) => {
    const product = await db.product.findUniqueOrThrow({ where: { id }, select: publicationFields });
    requirePublicationReadiness(await evaluatePublication(db, product));
  });
}

export async function setWorkspaceProductPublication(actorId: string, raw: unknown) {
  const { productId, revision, publication } = catalogWriteInput(publishInput, raw);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockTaxonomy(tx);
    await lockProductEdits(tx, productId);
    await lockCatalogProductQuoteRows(tx, productId);
    const product = await tx.product.findUnique({ where: { id: productId }, select: publicationFields });
    if (!product?.foundation) throw new CatalogWriteError("not_found", "Choose a connected catalog product.");
    if (product.sellerListingReviews.length) throw new CatalogWriteError("conflict", "Publish this listing from its market review.");
    if (product.revision !== revision) throw new CatalogWriteError("conflict", "This product changed. Reload it before changing publication.");
    if (product.publication === "ARCHIVED") throw new CatalogWriteError("conflict", "This product is archived.");
    if (publication === "ACTIVE") requirePublicationReadiness(await evaluatePublication(tx, product));
    if (product.publication === publication) return { id: productId, publication, revision };
    const result = await tx.product.update({ where: { id: productId }, data: {
      publication, active: publication === "ACTIVE", revision: { increment: 1 },
    }, select: { id: true, publication: true, revision: true } });
    await tx.auditEvent.create({ data: { actorId, action: "PRODUCT_SAVED", target: productId,
      changes: { kind: "publication", before: product.publication, after: publication, revision: result.revision } } });
    return result;
  }, { timeout: 20_000 });
}
