import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { MAX_QUANTITY } from "../cart/model.ts";
import { catalogVariantWhere } from "../catalog/connected-public.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import { departmentAncestorPath, departmentFamily } from "../catalog/departments.ts";
import { knownCatalogDevice } from "../catalog/devices.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { storeShop } from "../marketplace/constants.ts";
import { merchantProductEligibility, sellerVisibility } from "../marketplace/market-grants.ts";
import { productionMode } from "../release-config.ts";
import { acquisitionCampaign } from "./campaign.ts";
import { defaultHomepageConfig, publishedHomepage } from "../catalog/homepage-content.ts";
import { activeHomepageSections, defaultHomepage, featuredCampaigns, homepageSectionPlacements, type HomepageContentData } from "../catalog/homepage-contract.ts";
import { lockExperimentPreference, recommendationExperimentEnabled } from "../catalog/recommendation-experiment-data.ts";
import { recommendationExperimentPlan as experimentPlan } from "../catalog/recommendation-experiment-plan.ts";
import { marketConfiguration } from "../market-config.ts";
import { journeySeconds, measurementRetentionDays, stableMeasurementId, vettedCampaign } from "./domain.ts";
import { browserMeasurementSchema, type MeasurementFilters } from "./schema.ts";

export const measurementCookie = "griipbuddy-measurement";
export const choiceSeconds = measurementRetentionDays * 86_400;
export const measurementEnabled = () => process.env.ACQUISITION_MEASUREMENT === "1";
export const measurementSessionHeader = "x-griipbuddy-measurement-session";
const tokenPattern = /^([a-f0-9]{64})\.(\d{10})\.([a-f0-9]{64})$/;

// Suppress measurements from browsers carrying a staff sign-in. The marker is
// used for measurement classification only, never for authorization.
export function hasStaffMeasurementSession(headers: Headers) {
  return /(?:^|;\s*)(?:__Secure-)?griipbuddy-(?:staff|release-staff|demo-admin)\.session_token=[^;]+/.test(headers.get("cookie") ?? "");
}

function signature(payload: string) {
  const secret = process.env.CHECKOUT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Missing checkout signing secret");
  return createHmac("sha256", secret).update("acquisition-consent\0").update(payload).digest("hex");
}

export function measurementAccountKey(shopperId: string) {
  return signature(`shopper\0${shopperId}`);
}

export function cookieId(value: string | undefined, permitExpired = false) {
  const match = value && tokenPattern.exec(value);
  if (!match || (!permitExpired && Number(match[2]) <= Math.floor(Date.now() / 1000))) return null;
  const expected = signature(`${match[1]}.${match[2]}`);
  if (!timingSafeEqual(Buffer.from(match[3], "hex"), Buffer.from(expected, "hex"))) return null;
  return stableMeasurementId("consent", match[1]);
}

export async function grantMeasurement() {
  const token = randomBytes(32).toString("hex");
  const expires = Math.floor(Date.now() / 1000) + choiceSeconds;
  const payload = `${token}.${expires}`;
  await getDb().measurementJourney.create({
    data: {
      id: stableMeasurementId("consent", token),
      test: !productionMode(), expiresAt: new Date((expires - choiceSeconds + journeySeconds) * 1000),
    },
  });
  return `${payload}.${signature(payload)}`;
}

export async function revokeMeasurement(token: string | undefined) {
  const id = cookieId(token, true);
  if (id) await getDb().measurementJourney.deleteMany({ where: { id } });
}

export async function pruneMeasurement(now = new Date(), options: { testOnly?: boolean } = {}) {
  const inactiveSince = new Date(+now - measurementRetentionDays * 86_400_000);
  return (await getDb().measurementJourney.deleteMany({ where: {
    grantedAt: { lt: inactiveSince }, ...(options.testOnly && { test: true }),
  } })).count;
}

const catalogueId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const uuid = z.uuid();
const campaign = z.strictObject({
  utm_source: z.string().max(32), utm_medium: z.string().max(32),
  utm_campaign: z.string().max(64), utm_content: z.string().max(64),
});

const legacyMeasurementInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("allow") }),
  z.strictObject({ action: z.literal("withdraw") }),
  z.strictObject({
    action: z.literal("PRODUCT_VIEW"), nonce: uuid, variantId: catalogueId, campaign: campaign.optional(),
  }),
  z.strictObject({
    action: z.literal("CART_ADD"), nonce: uuid, variantId: catalogueId, quantity: z.number().int().min(1).max(MAX_QUANTITY),
  }),
  z.strictObject({ action: z.literal("CHECKOUT_START"), nonce: uuid }),
]);

export const measurementInput = z.union([legacyMeasurementInput, browserMeasurementSchema]);
export type MeasurementInput = z.infer<typeof measurementInput>;
type Observation = Exclude<MeasurementInput, { action: "allow" | "withdraw" }>;

const homePlacements = new Set([
  "home-hero", "home-departments", "home-collections", "home-new-arrivals", "home-featured", "home-sale-banner",
  "home-deals", "home-category-spotlight", "home-recently-viewed", "home-models", "home-gifts", "home-bestsellers", "home-trending", "home-similar",
  "recommended", "continue", "buy-again", ...featuredCampaigns,
]);
const recommendationPlacements = new Set(["recommended", "continue", "similar", "complementary", "bestsellers", "trending", "buy-again",
  "home-bestsellers", "home-trending", "home-similar"]);
const placements = new Set([
  ...homePlacements, "product-detail", "product-add-ons", "related-products", "product-grid", "shop", "checkout", "cart",
  "search-results", "search-suggestion", "department", "collection", "shop-listings", "gift-listings", "wishlist", "favorites",
  "search-box", "search-model-suggestion", "search-category-suggestion",
  "category-listing", "category-grid", "category-children", "category-navigation",
  ...recommendationPlacements,
]);
const homepageConfigs = new Set(["retail-home-v1", "marketplace-home-v1", "marketplace-sale-home-v1", defaultHomepageConfig]);

async function vettedHomepageConfig(marketId: MarketId, value: string | undefined, placement: string, sectionId: string | undefined, at: Date) {
  if (!value || (!sectionId && homepageConfigs.has(value))) return value;
  const market = marketConfiguration(marketId);
  const includesSection = (layers: readonly HomepageContentData[]) => !sectionId || activeHomepageSections(layers, at, market.timeZone).some(section =>
    section.key === sectionId && (homepageSectionPlacements[section.type] === placement ||
      section.type === "FEATURED" && placement === "recommended" || section.type === "RECENTLY_VIEWED" && placement === "continue"));
  if (value === defaultHomepageConfig) return includesSection([defaultHomepage]) ? value : undefined;
  if (!/^home-release-[a-f0-9]{24}$/.test(value)) return;
  const candidates = await Promise.all(market.languages.map(locale => publishedHomepage(marketId, locale)));
  return candidates.some(candidate => candidate.measurement === value && includesSection(candidate.layers)) ? value : undefined;
}

async function verifiedFilters(db: DbReader, marketId: MarketId, input: MeasurementFilters | undefined) {
  if (!input) return undefined;
  const { color, department, shop, device, ...filters } = input;
  const [hasColor, hasDepartment, hasShop] = await Promise.all([
    color && db.variant.findFirst({ where: { active: true, options: { path: ["Color"], equals: color },
      offers: { some: { marketId, eligible: true } }, product: { active: true, publication: "ACTIVE", ...merchantProductEligibility(marketId) } },
    select: { id: true } }),
    department && db.department.findUnique({ where: { slug: department }, select: { id: true } }),
    shop && (shop === storeShop.slug || db.marketplaceShop.findFirst({ where: { slug: shop, ...sellerVisibility(marketId) }, select: { id: true } })),
  ]);
  return {
    ...filters, ...(hasColor && { color }), ...(hasDepartment && { department }), ...(hasShop && { shop }),
    ...(device && knownCatalogDevice(device) && { device }),
  };
}

async function categoryObservation(db: DbReader, marketId: MarketId, categoryId: string, test: boolean,
  productId?: string, variantId?: string) {
  const rows = await db.department.findMany({ where: { state: "ACTIVE" }, select: { id: true, parentId: true } });
  const byId = new Map(rows.map(row => [row.id, row]));
  if (!departmentAncestorPath(byId, categoryId)) return false;
  if (!productId) return true;
  const ids = [...departmentFamily(rows, categoryId)];
  const membership: Prisma.ProductWhereInput = {
    id: productId, ...(test ? {} : { demo: false }),
    OR: [{ departmentId: { in: ids } }, { secondaryCategories: { some: { departmentId: { in: ids } } } }],
  };
  return Boolean(await db.variant.findFirst({
    where: { id: variantId, AND: [catalogVariantWhere(marketId), { product: membership }] },
    select: { id: true },
  }));
}

export async function recordMeasurement(journeyId: string, marketId: MarketId, input: Observation, shopperId?: string, experimentPreferenceSince?: Date) {
  const db = getDb();
  const now = new Date();
  const journey = await db.measurementJourney.findFirst({
    where: { id: journeyId, expiresAt: { gt: now } }, select: { test: true, grantedAt: true },
  });
  if (!journey || (input.action === "ACCOUNT_ASSOCIATED" && !shopperId)) return false;
  const event = "version" in input ? input : undefined;
  const at = event ? new Date(event.at) : now;
  // Tolerate modest browser clock drift while keeping events inside the
  // consent window and rejecting replayed data well outside the request time.
  if (!Number.isFinite(+at) || Math.abs(+at - +now) > 5 * 60_000) return false;
  const recordedAt = new Date(Math.min(+now, Math.max(+journey.grantedAt, +at)));
  const productScope = {
    active: true, publication: "ACTIVE" as const, ...merchantProductEligibility(marketId), ...(journey.test ? {} : { demo: false }),
  };
  const placement = event?.placement && placements.has(event.placement) ? event.placement : undefined;
  const searchCard = (placement === "search-results" || placement === "search-suggestion") &&
    (input.action === "PRODUCT_IMPRESSION" || input.action === "PRODUCT_CLICK");
  const homepageConfig = placement && homePlacements.has(placement)
    ? await vettedHomepageConfig(marketId, event?.homepageConfig, placement, event?.sectionId, recordedAt) : undefined;
  if (event?.sectionId && !homepageConfig) return false;
  if (input.action === "HOMEPAGE_SECTION_IMPRESSION" && (!homepageConfig || !placement || !homePlacements.has(placement))) return false;
  let productId = event?.productId;
  const variantId = "variantId" in input ? input.variantId : undefined;
  if (event?.currency && event.currency !== markets[marketId].currency) return false;
  if (event?.categoryId) {
    if (!await categoryObservation(db, marketId, event.categoryId, journey.test, productId, variantId)) return false;
  } else if (variantId) {
    const variant = await db.variant.findFirst({
      where: {
        id: variantId, active: true,
        ...(event?.offerId || searchCard ? {
          AND: [catalogVariantWhere(marketId)],
          product: { ...(journey.test ? {} : { demo: false }) },
          ...(event?.offerId && { offers: { some: { ...connectedOfferScope(marketId), offerId: event.offerId } } }),
        } : { product: productScope }),
      },
      select: {
        productId: true,
        offers: { where: { marketId, ...(event?.offerId ? { offerId: event.offerId } : searchCard ? {} : { eligible: true }) },
          select: { currency: true } },
      },
    });
    if (!variant || (productId && productId !== variant.productId)) return false;
    if (variant.offers[0]?.currency !== markets[marketId].currency) return false;
    productId = variant.productId;
  } else if (productId) {
    const visible = searchCard
      ? db.variant.findFirst({ where: { AND: [catalogVariantWhere(marketId)], productId,
        product: { ...(journey.test ? {} : { demo: false }) } }, select: { id: true } })
      : db.product.findFirst({ where: { id: productId, ...productScope,
        variants: { some: { active: true, offers: { some: { marketId, eligible: true, currency: markets[marketId].currency } } } },
      }, select: { id: true } });
    if (!await visible) return false;
  }
  const campaign = vettedCampaign("campaign" in input ? input.campaign : undefined, marketId === acquisitionCampaign.marketId &&
    variantId === acquisitionCampaign.variantId && productId === acquisitionCampaign.productId);
  const observationDetails = event?.categoryId ? {
    categoryId: event.categoryId,
    ...(event.action === "CATEGORY_IMPRESSION" && { resultCount: event.resultCount }),
    ...(event.action === "CATEGORY_FILTER" && {
      resultCount: event.resultCount,
      filterFields: event.categoryFilters?.fields,
      sort: event.categoryFilters?.sort,
    }),
  } : event?.action === "SEARCH" || event?.action === "SEARCH_FILTER"
    ? event.searchStage ? { searchStage: event.searchStage } : {
      query: event.query, resultCount: event.resultCount, filters: await verifiedFilters(db, marketId, event.filters),
      ...(event.categoryFilters && { filterFields: event.categoryFilters.fields, sort: event.categoryFilters.sort }),
    }
    : event?.action === "CHECKOUT_STEP" || event?.action === "CHECKOUT_FAILURE"
      ? { step: event.step, failureCode: event.failureCode } : undefined;
  const details = event?.offerId || event?.sectionId ? { ...observationDetails,
    ...(event.offerId && { offerId: event.offerId }), ...(event.sectionId && { sectionId: event.sectionId }),
  } : observationDetails;
  const id = event?.sectionId && homepageConfig &&
    (input.action === "HOMEPAGE_SECTION_IMPRESSION" || input.action === "PRODUCT_IMPRESSION")
    ? stableMeasurementId("homepage-impression", journeyId, event.sessionId, marketId, homepageConfig, event.sectionId,
      input.action, productId ?? "", variantId ?? "")
    : stableMeasurementId("observation", journeyId, input.action, input.nonce);
  const accountKey = shopperId ? measurementAccountKey(shopperId) : undefined;
  const recommendationVersion = placement && recommendationPlacements.has(placement) ? event?.recommendationVersion : undefined;
  const data = {
    id, journeyId, kind: input.action, marketId, productId, variantId, campaign, accountKey,
    quantity: "quantity" in input ? input.quantity : undefined,
    at: recordedAt, receivedAt: now, schemaVersion: event?.version ?? 1, sessionId: event?.sessionId,
    amountMinor: event?.displayedPriceMinor, currency: event?.currency, campaignSource: event?.campaignSource ?? (campaign ? "facebook" : undefined),
    placement, position: placement ? event?.position : undefined, homepageConfig, details,
  };
  const assignmentId = event?.experimentAssignment;
  try {
    if (assignmentId && experimentPreferenceSince && recommendationVersion && placement === experimentPlan.placement &&
        journey.test && recommendationExperimentEnabled()) {
      const verified = await db.$transaction(async tx => {
        if (!await lockExperimentPreference(tx, journeyId, experimentPreferenceSince, accountKey ?? null)) return false;
        const assignment = await tx.recommendationExperimentAssignment.findFirst({
          where: { id: assignmentId, journeyId, marketId, experimentId: experimentPlan.id, preferenceSince: experimentPreferenceSince },
          select: { assignedAt: true },
        });
        if (!assignment) return false;
        const exposure = input.action === "EXPERIMENT_EXPOSURE";
        await tx.measurementEvent.createMany({
          data: { ...data, id: exposure ? stableMeasurementId("experiment-exposure", assignmentId, placement) : id,
            at: recordedAt < assignment.assignedAt ? assignment.assignedAt : recordedAt, experimentAssignment: assignmentId, recommendationVersion },
          skipDuplicates: true,
        });
        return true;
      });
      if (verified) return true;
    }
    if (input.action === "EXPERIMENT_EXPOSURE") return false;
    await db.measurementEvent.createMany({ data: { ...data, recommendationVersion: assignmentId ? undefined : recommendationVersion }, skipDuplicates: true });
    return true;
  } catch (error) {
    // Withdrawal can delete the journey between the eligibility check and insert.
    if (typeof error === "object" && error && "code" in error && error.code === "P2003") return false;
    throw error;
  }
}

export async function linkCheckoutAttempt(attemptId: string, guestKey: string, journeyId: string, marketId: MarketId, sessionId: string) {
  await getDb().$executeRaw`
    INSERT INTO "MeasurementAttempt" ("attemptId", "journeyId", "marketId", "sessionId")
    SELECT a.id, j.id, ${marketId}::"MarketCode", ${sessionId}::uuid
    FROM "CheckoutAttempt" a JOIN "MeasurementJourney" j ON j.id = ${journeyId}
    LEFT JOIN "Order" o ON o."attemptId" = a.id
    WHERE a.id = ${attemptId}::uuid AND a."guestKey" = ${guestKey}
      AND a."marketId" = ${marketId}::"MarketCode"
      AND (a."commerceEvidence" IS NULL OR (a."commerceEvidence" <> 'production') = j.test)
      AND a."createdAt" >= j."grantedAt" AND a."createdAt" < j."expiresAt" AND j."expiresAt" > CURRENT_TIMESTAMP
      AND (o.id IS NULL OR (o."marketId" = ${marketId}::"MarketCode" AND o."measurementTest" = j.test))
    ON CONFLICT ("attemptId") DO NOTHING
  `;
}

export async function linkAcceptedOrder(orderId: string, guestKey: string, journeyId: string, sessionId?: string) {
  // Only called with an ID returned by the authoritative checkout submit/recover.
  // The unique order key makes retries safe; use the earliest complete linkage.
  await getDb().$executeRaw`
    INSERT INTO "MeasurementOrder" ("orderId", "journeyId", "sessionId")
    SELECT o.id, j.id, ${sessionId ?? null}::uuid
    FROM "Order" o
    JOIN "CheckoutAttempt" a ON a.id = o."attemptId"
    JOIN "MeasurementJourney" j ON j.id = ${journeyId}
    WHERE o.id = ${orderId}::uuid AND a."guestKey" = ${guestKey}
      AND o."measurementTest" = j.test
      AND j."grantedAt" <= o."createdAt" AND j."expiresAt" > o."createdAt" AND j."expiresAt" > CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1 FROM "MeasurementEvent" e
        WHERE e."journeyId" = j.id AND e."marketId" = o."marketId"
          AND e.kind = 'CHECKOUT_START' AND e.at >= j."grantedAt" AND e.at <= o."createdAt"
          AND (${sessionId ?? null}::uuid IS NULL OR e."sessionId" = ${sessionId ?? null}::uuid)
      )
    ON CONFLICT ("orderId") DO NOTHING
  `;
}
