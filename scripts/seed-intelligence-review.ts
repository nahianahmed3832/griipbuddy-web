import "./load-env.ts";
import { marketIds, type MarketId } from "../src/config/markets.ts";
import { type Prisma } from "../src/generated/prisma/client.ts";
import { getDb } from "../src/lib/db/client.ts";
import { stagingDatabase } from "../src/lib/db/local.ts";
import { marketConfiguration } from "../src/lib/market-config.ts";
import { localMarketTime, marketDay, shiftCalendarDay } from "../src/lib/market-calendar.ts";
import { stableMeasurementId } from "../src/lib/measurement/domain.ts";

if (process.env.GRIIP_MARKET_REVIEW_FIXTURES !== "1" || !stagingDatabase() ||
    marketIds.some(id => marketConfiguration(id).status !== "staging" || marketConfiguration(id).catalog.inventory !== "market-locations")) {
  throw new Error("Use the dedicated market review staging database and market profile.");
}

const products = {
  bd: { variant: "v-lamp-cream", stock: 2, term: "usb c travel lamp with dimmer", alternate: "usb c table lamp", zone: "dhaka", method: "standard" },
  us: { variant: "v-speaker-charcoal", stock: 3, term: "waterproof travel speaker ipx7", alternate: "travel speaker", zone: "ny", method: "ground" },
} satisfies Record<MarketId, { variant: string; stock: number; term: string; alternate: string; zone: string; method: string }>;

function id(...parts: string[]) { return stableMeasurementId("product-intelligence-fixture-v1", ...parts); }
function uuid(...parts: string[]) {
  const key = id(...parts);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

const db = getDb();
const now = new Date();
const hour = 3_600_000;
try {
  for (const marketId of marketIds) {
    const market = marketConfiguration(marketId);
    const marketFixture = products[marketId];
    const today = marketDay(now, market.timeZone);
    const range = Array.from({ length: 165 }, (_, index) => shiftCalendarDay(today, index - 165)!);
    const fixtures = await db.variant.findMany({ where: { id: { in: [marketFixture.variant, "v-notebooks-pair"] }, product: { demo: true } },
      select: { id: true, label: true, sku: true, product: { select: { id: true, name: true } },
        offers: { where: { marketId, eligible: true, currency: market.currency }, select: { amountMinor: true } } } });
    const primary = fixtures.find(row => row.id === marketFixture.variant);
    if (fixtures.length !== 2 || !primary || fixtures.some(row => !row.offers.length)) throw new Error(`Missing eligible demo catalog in ${marketId}.`);
    const locationId = `review-dispatch-${marketId}`;
    const inventory = await db.locationInventory.findUniqueOrThrow({ where: { variantId_locationId: { variantId: primary.id, locationId } },
      select: { available: true, location: { select: { marketId: true, active: true } } } });
    if (inventory.location.marketId !== marketId || !inventory.location.active) throw new Error(`Invalid fixture inventory location for ${marketId}.`);
    const snapshots: Prisma.ProductIntelligenceSnapshotCreateManyInput[] = [];
    const attempts: Prisma.CheckoutAttemptCreateManyInput[] = [];
    const booked: Prisma.OrderCreateManyInput[] = [];
    const lines: Prisma.OrderItemCreateManyInput[] = [];
    const payments: Prisma.PaymentCreateManyInput[] = [];
    const remittances: Prisma.CodRemittanceCreateManyInput[] = [];
    const events: Prisma.FulfillmentEventCreateManyInput[] = [];
    const finance: Prisma.OrderContributionEvidenceCreateManyInput[] = [];

    for (const row of fixtures) {
      const major = row.id === primary.id;
      for (const day of range) {
        const index = Math.floor(+new Date(`${day}T00:00:00Z`) / (24 * hour));
        const stockout = major ? index % 77 < 4 : index % 91 === 0;
        const inPromotion = index % 82 === 16 || index % 82 === 17;
        const price = row.offers[0].amountMinor;
        const discount = inPromotion ? Math.round(price * .1) : 0;
        for (const minute of ["01:05", "07:05", "13:05", "19:05"]) {
          const observedAt = localMarketTime(`${day}T${minute}`, market.timeZone);
          if (observedAt) snapshots.push({ marketId, currency: market.currency, test: true, variantId: row.id,
            slot: new Date(Math.floor(+observedAt / hour) * hour), observedAt, priceMinor: price,
            discountMinor: discount, available: stockout ? 0 : 9 + index % 11, deliveryAvailable: true, source: "staging-synthetic-fixture" });
        }
        const at = localMarketTime(`${day}T11:30`, market.timeZone)!;
        const captureAt = new Date(+at + 25 * hour);
        const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
        const units = stockout ? 0 : major ? 1 + (weekday === 5 || weekday === 6 ? 2 : 0) + (inPromotion ? 1 : 0)
          : index % (marketId === "bd" ? 4 : 7) === 0 ? 2 + (index % 3) : 0;
        if (!units) continue;
        const attemptId = uuid("attempt", marketId, row.id, day);
        const orderId = uuid("order", marketId, row.id, day);
        const completed = captureAt < now;
        const total = (price - discount) * units;
        attempts.push({ id: attemptId, guestKey: id("guest", marketId, row.id, day), requestHash: id("request", marketId, row.id, day),
          createdAt: at, marketId, paymentMethod: "COD", commerceEvidence: "fixture" });
        booked.push({ id: orderId, reference: `INT-${marketId.toUpperCase()}-${id("reference", marketId, row.id, day).slice(0, 12)}`,
          attemptId, marketId, currency: market.currency, status: "PLACED", fulfillmentStatus: completed ? "DELIVERED" : "UNFULFILLED",
          customerName: "Intelligence Review Fixture", phone: "00000000000", district: marketFixture.zone,
          districtLabel: "Fixture zone", locality: "Fixture locality", address: "Synthetic fixture address",
          deliveryMethod: marketFixture.method, deliveryLabel: "Fixture service", taxLabel: "Fixture tax",
          subtotalMinor: price * units, discountMinor: discount * units, deliveryMinor: 0, taxMinor: 0, totalMinor: total,
          createdAt: at, updatedAt: completed ? captureAt : at, measurementTest: true, commerceEvidence: "fixture" });
        lines.push({ id: uuid("line", marketId, row.id, day), orderId, variantId: row.id, productName: row.product.name, sku: row.sku,
          variantName: row.label, quantity: units, unitPriceMinor: price, unitDiscountMinor: discount, lineTotalMinor: total, currency: market.currency });
        payments.push({ orderId, method: "COD", status: completed ? "COLLECTED" : "AWAITING_COLLECTION", amountMinor: total,
          currency: market.currency, createdAt: at, collectedAt: completed ? captureAt : null });
        if (completed) {
          events.push({ id: uuid("delivery", marketId, row.id, day), orderId, type: "STATUS_CHANGED", status: "DELIVERED", createdAt: captureAt });
          const remittanceAt = new Date(+captureAt + 24 * hour);
          const matched = index % 4 === 0 && remittanceAt < now;
          if (matched) {
            const deductionsMinor = Math.round(total * .01);
            remittances.push({ orderId, attempt: 1, status: "MATCHED", reference: `REVIEW-${id("remittance", marketId, row.id, day).slice(0, 12)}`,
              expectedGrossMinor: total, grossMinor: total, deductionsMinor, netMinor: total - deductionsMinor, createdAt: remittanceAt });
          }
          if (!major) finance.push({ orderId, currency: market.currency, source: "staging-synthetic-fixture", verifiedThrough: matched ? remittanceAt : captureAt,
            revenueBeforeRefundsMinor: total, refundsMinor: 0, itemCostMinor: Math.round(total * .55), packagingMinor: Math.round(total * .04),
            outboundMinor: Math.round(total * .08), returnMinor: 0, paymentFeesMinor: Math.round(total * .02) });
        }
      }
    }

    const traces: Prisma.MeasurementJourneyCreateManyInput[] = [];
    const behavior: Prisma.MeasurementEventCreateManyInput[] = [];
    for (let index = 0; index < 12; index++) {
      const day = shiftCalendarDay(today, -1 - index % 5)!;
      const time = localMarketTime(`${day}T14:00`, market.timeZone)!;
      const journeyId = id("behavior", marketId, day, String(index));
      const sessionId = uuid("session", marketId, day, String(index));
      traces.push({ id: journeyId, test: true, grantedAt: time, expiresAt: new Date(+time + 7 * 24 * hour) });
      const add = (kind: Prisma.MeasurementEventCreateManyInput["kind"], step: number, data: Partial<Prisma.MeasurementEventCreateManyInput> = {}) => {
        const at = new Date(+time + step * 30_000);
        behavior.push({ id: id("observed", marketId, journeyId, kind, String(step)), kind, journeyId, sessionId, marketId,
          at, receivedAt: at, schemaVersion: 1, ...data });
      };
      const catalog = { productId: primary.product.id, variantId: primary.id };
      add("SEARCH", 0, { details: { query: marketFixture.term, resultCount: 0 } });
      add("SEARCH", 2, { details: { query: marketFixture.alternate, resultCount: 1 } });
      add("PRODUCT_IMPRESSION", 3, { ...catalog, placement: "search-results" });
      add("PRODUCT_VIEW", 4, { ...catalog, placement: "product-detail", campaignSource: index % 2 ? "direct" : "facebook" });
      if (index < 5) add("WISHLIST_ADD", 5, catalog);
      if (index < 4) add("CART_ADD", 6, { ...catalog, quantity: 1 });
      if (index < 3) add("CHECKOUT_START", 7);
      if (index === 0) add("CHECKOUT_FAILURE", 8, { details: { step: "address", failureCode: "unavailable" } });
    }

    await db.$transaction(async tx => {
      await tx.productIntelligenceSnapshot.createMany({ data: snapshots, skipDuplicates: true });
      await tx.checkoutAttempt.createMany({ data: attempts, skipDuplicates: true });
      await tx.order.createMany({ data: booked, skipDuplicates: true });
      await tx.orderItem.createMany({ data: lines, skipDuplicates: true });
      await tx.payment.createMany({ data: payments, skipDuplicates: true });
      await tx.codRemittance.createMany({ data: remittances, skipDuplicates: true });
      await tx.fulfillmentEvent.createMany({ data: events, skipDuplicates: true });
      await tx.orderContributionEvidence.createMany({ data: finance, skipDuplicates: true });
      await tx.measurementJourney.createMany({ data: traces, skipDuplicates: true });
      await tx.measurementEvent.createMany({ data: behavior, skipDuplicates: true });
      await tx.locationInventory.updateMany({ where: { variantId: primary.id, locationId, available: { gt: marketFixture.stock } },
        data: { available: marketFixture.stock } });
    }, { timeout: 25_000 });
    console.log(`${marketId.toUpperCase()} ${market.currency}: staged ${fixtures.length} demo variants across ${range[0]} to ${range.at(-1)}, ${booked.length} bookings, ${snapshots.length} observations, ${remittances.length} remittances, ${traces.length} browsing fixtures.`);
  }
} finally {
  await db.$disconnect();
}
