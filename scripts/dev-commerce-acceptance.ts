import assert from "node:assert/strict";
import { z } from "zod";
import { getDb } from "../src/lib/db/client.ts";
import { developmentAcceptanceDatabase } from "../src/lib/db/local.ts";
import { firstPartyStoreMode, orderIntakeOpen } from "../src/lib/release-config.ts";
import { configuredPayment } from "../src/lib/commerce/market-commerce.ts";
import { integratedCheckout } from "../src/lib/commerce/integrated-checkout.ts";
import { advanceFulfillment, collectCash } from "../src/lib/staff/operations.ts";
import { dispatchOrderParcel, recordOrderParcelTracking } from "../src/lib/commerce/order-parcels.ts";
import { recordCodRemittance } from "../src/lib/staff/cod-remittance.ts";
import { executeOrderCase } from "../src/lib/marketplace/cases.ts";
import { commerceOutcomeSelect, projectCommerceOutcomes } from "../src/lib/measurement/outcomes.ts";
import { acquisitionReport } from "../src/lib/measurement/report.ts";
import { stableMeasurementId } from "../src/lib/measurement/domain.ts";
import { measurementAccountKey } from "../src/lib/measurement/server.ts";

const [command, run, ...values] = process.argv.slice(2);
if (!developmentAcceptanceDatabase() || firstPartyStoreMode() || !orderIntakeOpen() ||
    process.env.ACQUISITION_MEASUREMENT !== "1" || !run || !/^[a-z0-9]{6,16}$/.test(run)) {
  throw new Error("Use the designated marketplace development acceptance profile with a synthetic run ID.");
}

const productSlug = `devqa-${run}`;
const sellerProductSlug = `${productSlug}-seller`;
const productId = `p-${productSlug}`;
const sellerProductId = `p-${sellerProductSlug}`;
const variantId = `v-${productSlug}-sku`;
const initialStock = 4;
const fixture = {
  bd: { country: "BD", district: "dhaka", districtLabel: "Dhaka", currency: "BDT", service: "devqa-standard",
    label: "Development standard", amount: 112500, shipping: 8500 },
  us: { country: "US", district: "ny", districtLabel: "New York", currency: "USD", service: "devqa-ground",
    label: "Development ground", amount: 1999, shipping: 499 },
} as const;
const db = getDb();

async function seed() {
  for (const marketId of ["bd", "us"] as const) {
    const payment = configuredPayment(marketId, "COD");
    assert.equal(payment?.evidence, "fixture");
    assert.equal(payment.market.pricing.taxTreatment, "MERCHANDISE_RATE");
    assert.equal(payment.market.catalog.inventory, "market-locations");
    assert.ok(payment.fulfillment.includes("manual"));
    assert.ok(payment.returns.includes("manual"));
    assert.equal(integratedCheckout(marketId), null);
  }
  const configured = await db.$transaction(async tx => {
    const department = await tx.department.findFirstOrThrow({ orderBy: { position: "asc" }, select: { id: true } });
    const usd = await tx.checkoutPolicy.findUnique({ where: { marketId: "us" } });
    const developmentUsdPolicy = { enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE" as const,
      taxBasisPoints: 825, taxLabel: "Development fixture tax (8.25%)", revision: 1 };
    let initializedUsdPolicy = false;
    if (!usd) {
      await tx.checkoutPolicy.create({ data: { marketId: "us", countryCode: "US", currency: "USD", ...developmentUsdPolicy } });
      initializedUsdPolicy = true;
    } else if (!usd.enabled && !usd.codEnabled && usd.taxTreatment === null && usd.taxBasisPoints === null && usd.taxLabel === null && usd.revision === 0) {
      const update = await tx.checkoutPolicy.updateMany({
        where: { marketId: "us", countryCode: "US", currency: "USD", enabled: false, codEnabled: false,
          taxTreatment: null, taxBasisPoints: null, taxLabel: null, revision: 0 },
        data: developmentUsdPolicy,
      });
      assert.equal(update.count, 1);
      initializedUsdPolicy = true;
    }
    for (const marketId of ["bd", "us"] as const) {
      const config = fixture[marketId];
      const policy = await tx.checkoutPolicy.findUniqueOrThrow({ where: { marketId } });
      assert.ok(policy.enabled && policy.codEnabled && policy.countryCode === config.country && policy.currency === config.currency &&
        policy.taxTreatment === "MERCHANDISE_RATE" && policy.taxBasisPoints !== null && policy.taxLabel,
      `${marketId} requires an existing compatible native checkout policy`);
      const zone = { marketId, district: config.district, districtLabel: config.districtLabel, method: config.service,
        label: config.label, chargeMinor: config.shipping, codEligible: true };
      const stored = await tx.deliveryZone.upsert({
        where: { marketId_district_method: { marketId, district: zone.district, method: zone.method } }, create: zone, update: {},
      });
      assert.equal(stored.chargeMinor, zone.chargeMinor);
      assert.ok(stored.enabled && stored.codEligible && stored.label === zone.label);
    }
    await tx.deliveryZone.upsert({
      where: { marketId_district_method: { marketId: "us", district: "ny", method: "devqa-express" } }, update: {},
      create: { marketId: "us", district: "ny", districtLabel: "New York", method: "devqa-express", label: "Development express", chargeMinor: 999 },
    });
    const seller = await tx.marketplaceShop.create({
      data: { slug: sellerProductSlug, name: `Development fixture seller ${run}`, announcement: "Synthetic development data",
        about: "Development acceptance fixture with market-specific access.", published: true,
        marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }, { marketId: "us", status: "DENIED" }] } },
    });
    const image = { src: "/catalog/tote-oat.webp", alt: "Development fixture bag", position: 0 };
    for (const { id, slug, name, shopId } of [
      { id: productId, slug: productSlug, name: `Development fixture tote ${run}`, shopId: null },
      { id: sellerProductId, slug: sellerProductSlug, name: `Development fixture seller tote ${run}`, shopId: seller.id },
    ]) {
      const fixtureSku = `v-${slug}-sku`;
      await tx.product.create({
        data: { id, slug, departmentId: department.id, name, brand: "Development Fixture", description: "Synthetic acceptance data.",
          specifications: [], keywords: [run, "tote"], addedOn: new Date(), position: -100, demo: true,
          featured: shopId === null, publication: "ACTIVE", marketplaceShopId: shopId,
          images: { create: image },
          variants: { create: { id: fixtureSku, sku: fixtureSku, options: { Color: "Oat" }, label: "Oat", position: 0,
            imageSrc: image.src, imageAlt: image.alt, identifiersNotAssigned: true, offers: { create: [
              { marketId: "bd", currency: "BDT", amountMinor: fixture.bd.amount },
              { marketId: "us", currency: "USD", amountMinor: fixture.us.amount },
            ] } } } },
      });
      for (const marketId of ["bd", "us"] as const) {
        await tx.dispatchLocation.create({ data: { id: `${slug}-${marketId}`, marketId, shopId,
          name: `Development ${marketId.toUpperCase()} ${run}`, inventory: { create: { variantId: fixtureSku, available: initialStock } } } });
      }
    }
    return { initializedUsdPolicy };
  });
  console.log(JSON.stringify({ productId, productSlug, variantId, sellerProductId, sellerProductSlug, evidence: "fixture", ...configured }));
}

const receiptSchema = z.object({
  marketId: z.enum(["bd", "us"]), orderId: z.uuid(), attemptId: z.uuid(), sessionId: z.uuid(),
  impressionNonce: z.string().min(1).max(100), shopperRevision: z.string().regex(/^[0-9]{1,2}$/), wishlistMeasured: z.boolean(),
});
type Receipt = z.infer<typeof receiptSchema>;
type FixtureOrder = Awaited<ReturnType<typeof fixtureOrder>>;

async function fixtureOrder(receipt: Receipt) {
  const order = await db.order.findUniqueOrThrow({
    where: { id: receipt.orderId },
    include: { attempt: true, items: true, parcels: true, payment: true, codRemittances: true, shopper: { select: { email: true } } },
  });
  const config = fixture[receipt.marketId];
  assert.equal(order.shopper?.email, `devqa-${run}-${receipt.marketId}.${receipt.shopperRevision}@example.invalid`);
  assert.deepEqual([order.marketId, order.currency, order.attemptId, order.measurementTest, order.commerceEvidence, order.deliveryMethod],
    [receipt.marketId, config.currency, receipt.attemptId, true, "fixture", config.service]);
  assert.equal(order.items.length, 1);
  assert.equal(order.parcels.length, 1);
  assert.deepEqual([order.items[0].variantId, order.items[0].quantity, order.parcels[0].locationId],
    [variantId, 1, `${productSlug}-${receipt.marketId}`]);
  assert.deepEqual([order.attempt.marketId, order.subtotalMinor, order.deliveryMinor, order.payment?.method,
    order.payment?.currency, order.payment?.amountMinor], [receipt.marketId, config.amount, config.shipping, "COD", config.currency, order.totalMinor]);
  assert.ok(order.commercialSnapshot && typeof order.commercialSnapshot === "object" &&
    "marketId" in order.commercialSnapshot && order.commercialSnapshot.marketId === receipt.marketId);
  return order;
}

async function assertStock(marketId: Receipt["marketId"], expected: number) {
  const inventory = await db.locationInventory.findUniqueOrThrow({
    where: { variantId_locationId: { variantId, locationId: `${productSlug}-${marketId}` } },
  });
  assert.equal(inventory.available, expected);
}

async function fulfill(actorId: string, order: FixtureOrder) {
  const [parcel] = order.parcels;
  assert.equal(order.payment?.status, "AWAITING_COLLECTION");
  await assertStock(order.marketId, initialStock - 1);
  const authority = async () => projectCommerceOutcomes(await db.order.findUniqueOrThrow({
    where: { id: order.id }, select: commerceOutcomeSelect,
  }), new Date());
  assert.deepEqual((await authority()).map(event => event.kind), ["ORDER_ACCEPTED"]);
  const delivery = { status: "DELIVERED", evidence: `Development fixture delivery ${run}` };
  const transit = { status: "OUT_FOR_DELIVERY", evidence: `Development fixture transit ${run}` };
  const remittance = { reference: `DEVQA-${order.reference}`, grossMinor: order.totalMinor, deductionsMinor: 11, netMinor: order.totalMinor - 11 };
  await assert.rejects(collectCash(actorId, order.id), /after the order is delivered/);
  await assert.rejects(recordOrderParcelTracking(actorId, order.id, parcel.id, delivery), /no longer available/);
  await assert.rejects(recordCodRemittance(actorId, order.id, remittance), /requires a delivered COD order/);
  await advanceFulfillment(actorId, order.id, { next: "PACKING" });
  await advanceFulfillment(actorId, order.id, { next: "READY_TO_SHIP" });
  const dispatch = { carrier: order.marketId === "bd" ? "Development Bangladesh district fixture" : "Development US ground fixture",
    trackingReference: `DEVQA-${run}-${order.marketId}` };
  await dispatchOrderParcel(actorId, order.id, parcel.id, dispatch);
  await dispatchOrderParcel(actorId, order.id, parcel.id, dispatch);
  await recordOrderParcelTracking(actorId, order.id, parcel.id, transit);
  await recordOrderParcelTracking(actorId, order.id, parcel.id, delivery);
  await recordOrderParcelTracking(actorId, order.id, parcel.id, delivery);
  await assert.rejects(recordOrderParcelTracking(actorId, order.id, parcel.id, transit), /no longer available/);
  assert.deepEqual((await authority()).map(event => event.kind), ["ORDER_ACCEPTED", "ORDER_DELIVERED"]);
  await assert.rejects(recordCodRemittance(actorId, order.id, remittance), /requires a delivered COD order/);
  await collectCash(actorId, order.id);
  await collectCash(actorId, order.id);
  assert.deepEqual((await authority()).map(event => event.kind), ["ORDER_ACCEPTED", "ORDER_DELIVERED", "COD_COLLECTED"]);
  assert.equal(await recordCodRemittance(actorId, order.id, remittance), "MATCHED");
  assert.equal(await recordCodRemittance(actorId, order.id, remittance), "MATCHED");
  assert.equal(await db.codRemittance.count({ where: { orderId: order.id } }), 1);
  assert.equal(await db.orderParcelEvent.count({ where: { parcelId: parcel.id, status: "DELIVERED" } }), 1);
  console.log(JSON.stringify({ marketId: order.marketId, orderId: order.id, orderItemId: order.items[0].id,
    currency: order.currency, totalMinor: order.totalMinor, remittedMinor: remittance.netMinor }));
}

async function verify(actorId: string, receipt: Receipt, order: FixtureOrder, caseId: string) {
  const orderCase = await db.orderCase.findUniqueOrThrow({ where: { id: z.uuid().parse(caseId) } });
  assert.deepEqual([orderCase.orderId, orderCase.kind, orderCase.status, orderCase.revision],
    [order.id, "RETURN", "OPEN", 0]);
  const owner = { role: "owner", id: actorId } as const;
  const review = { action: "review", caseId, note: "Development fixture return" } as const;
  const receive = { action: "receive", caseId, disposition: "RESTOCK", confirmed: true } as const;
  await assert.rejects(executeOrderCase(owner, { ...receive, revision: 0 }), { status: 409 });
  await executeOrderCase(owner, { ...review, revision: 0, status: "IN_REVIEW" });
  await executeOrderCase(owner, { ...review, revision: 1, status: "RETURN_APPROVED" });
  await executeOrderCase(owner, { ...receive, revision: 2 });
  await assert.rejects(executeOrderCase(owner, { ...receive, revision: 2 }), { status: 409 });
  await assertStock(receipt.marketId, initialStock);

  const reportOrder = await db.order.findUniqueOrThrow({ where: { id: order.id }, select: commerceOutcomeSelect });
  const outcomes = projectCommerceOutcomes(reportOrder, new Date());
  assert.deepEqual(outcomes.map(event => event.kind), [
    "ORDER_ACCEPTED", "ORDER_DELIVERED", "COD_COLLECTED", "COD_REMITTED", "RETURN_REQUESTED", "RETURN_RECEIVED",
  ]);
  const association = await db.measurementAttempt.findUniqueOrThrow({ where: { attemptId: receipt.attemptId } });
  assert.equal(association.marketId, receipt.marketId);
  assert.equal(association.sessionId, receipt.sessionId);
  assert.equal(await db.measurementOrder.count({ where: { orderId: order.id, journeyId: association.journeyId, sessionId: receipt.sessionId } }), 1);
  assert.equal(new Set(outcomes.map(event => event.id)).size, outcomes.length);
  assert.ok(outcomes.every(event => event.marketId === receipt.marketId && event.currency === order.currency &&
    event.evidence === "fixture" && event.test && event.sessionId === receipt.sessionId && event.journeyId === association.journeyId));
  const impression = stableMeasurementId("observation", association.journeyId, "PRODUCT_IMPRESSION", receipt.impressionNonce);
  const events = await db.measurementEvent.findMany({ where: { journeyId: association.journeyId, marketId: receipt.marketId, sessionId: receipt.sessionId } });
  assert.equal(events.filter(event => event.id === impression).length, 1, "The replayed impression must exist exactly once");
  assert.equal(await db.measurementEvent.count({ where: { journeyId: association.journeyId, marketId: { not: receipt.marketId } } }), 0);
  const kinds = ["PRODUCT_IMPRESSION", "SEARCH", "SEARCH_FILTER", "PRODUCT_CLICK", "PRODUCT_VIEW", "ACCOUNT_ASSOCIATED",
    "CART_ADD", "CHECKOUT_START", "CHECKOUT_STEP", ...(receipt.wishlistMeasured ? ["WISHLIST_ADD"] : []),
    ...(receipt.marketId === "us" ? ["CHECKOUT_FAILURE"] : [])];
  for (const kind of kinds) assert.ok(events.some(event => event.kind === kind), `Expected stored ${kind}`);
  assert.ok(order.shopperId && events.some(event => event.kind === "ACCOUNT_ASSOCIATED" && event.accountKey === measurementAccountKey(order.shopperId!)));

  const [testReport, productionReport] = await Promise.all([
    acquisitionReport({ marketId: receipt.marketId, test: true }),
    acquisitionReport({ marketId: receipt.marketId, test: false }),
  ]);
  assert.equal(testReport.kind, "report");
  assert.equal(productionReport.kind, "report");
  const evidence = testReport.debug.filter(event => outcomes.some(outcome => outcome.id === event.id));
  assert.equal(evidence.length, outcomes.length, "The market acquisition report must reconcile all outcomes by their stable event IDs");
  assert.ok(productionReport.debug.every(event => !outcomes.some(outcome => outcome.id === event.id)));
  assert.ok(testReport.behavior.checkoutToOrder >= 1 && testReport.commerce.delivered >= 1 &&
    testReport.commerce.codCollected >= 1 && testReport.commerce.returned >= 1 && testReport.commerce.finance.remittanceOrders >= 1);
  assert.equal(testReport.commerce.contribution.total, null);
  assert.ok(testReport.commerce.contribution.missing.some(([label]) => label === "Current reconciled financial evidence"));
  console.log(JSON.stringify({ marketId: receipt.marketId, fixtureOrder: order.id, currency: order.currency,
    sessionLinked: true, deduplicatedImpression: true, accountAssociated: true, productionReportExcluded: true,
    outcomes: evidence.map(event => ({ kind: event.kind, amountMinor: event.amountMinor, reference: event.id.slice(0, 12) })), browserEvents: kinds,
    restoredStock: initialStock, caseId, costData: "unavailable on fixture" }));
}

try {
  if (command === "seed") {
    assert.equal(values.length, 0);
    await seed();
  } else {
    const receipt = receiptSchema.parse(JSON.parse(values[0] ?? ""));
    const order = await fixtureOrder(receipt);
    const actor = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" }, select: { userId: true } });
    if (command === "fulfill") await fulfill(actor.userId, order);
    else if (command === "verify") await verify(actor.userId, receipt, order, values[1]);
    else if (command === "withdrawn") {
      assert.equal(await db.measurementOrder.count({ where: { orderId: order.id } }), 0);
      assert.equal(await db.measurementAttempt.count({ where: { attemptId: receipt.attemptId } }), 0);
      assert.equal(await db.measurementEvent.count({ where: { sessionId: receipt.sessionId } }), 0);
      console.log(JSON.stringify({ marketId: order.marketId, orderId: order.id, consentLinksDeleted: true, authorityRetained: true }));
    } else throw new Error("Choose seed, fulfill, verify, or withdrawn.");
  }
} finally {
  await db.$disconnect();
}
