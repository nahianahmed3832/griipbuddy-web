import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { config } from "dotenv";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { marketDay } from "../../src/lib/market-calendar.ts";
import { marketConfiguration } from "../../src/lib/market-config.ts";
import { stableMeasurementId } from "../../src/lib/measurement/domain.ts";
import { cookieId, grantMeasurement, measurementAccountKey, recordMeasurement, revokeMeasurement } from "../../src/lib/measurement/server.ts";
import {
  deleteRecommendationExperimentHistory, enrollRecommendationExperiment, recordRecommendationExperimentLatency,
} from "../../src/lib/catalog/recommendation-experiment-data.ts";
import { recommendationExperimentReport } from "../../src/lib/catalog/recommendation-experiment-report.ts";

config({ path: ".env.test", override: true, quiet: true });
requireLocalDatabase("griipbuddy_test");
process.env.ACQUISITION_MEASUREMENT = "1";
process.env.GRIIP_RECOMMENDATION_EXPERIMENT = "1";
const db = getDb();
test.after(() => db.$disconnect());

test("assignments survive sign-in and market round trips while isolation, dedupe and withdrawal hold", async () => {
  const token = await grantMeasurement();
  const journeyId = cookieId(token)!;
  const sessionId = randomUUID();
  const now = new Date();
  try {
    assert.equal(await enrollRecommendationExperiment("bd", journeyId, now, null), null);
    await db.recommendationPreference.create({ data: { journeyId, enabled: true, since: now } });
    const assignments = await Promise.all(Array.from({ length: 5 }, () => enrollRecommendationExperiment("bd", journeyId, now, null)));
    const bd = assignments[0];
    assert.ok(bd);
    assert.ok(assignments.every(row => row?.id === bd.id && row.variant === bd.variant));
    const us = await enrollRecommendationExperiment("us", journeyId, now, null);
    assert.ok(us && us.id !== bd.id);
    await recordRecommendationExperimentLatency(bd.id, 125.7);
    await recordRecommendationExperimentLatency(bd.id, 500);
    const exposure = { action: "EXPERIMENT_EXPOSURE" as const, marketId: "bd" as const, version: 1 as const,
      at: now.toISOString(), nonce: randomUUID(), sessionId, placement: "recommended",
      experimentAssignment: bd.id, recommendationVersion: "featured-v1" };
    assert.equal(await recordMeasurement(journeyId, "us", { ...exposure, marketId: "us" }, undefined, now), false);
    assert.equal(await recordMeasurement(journeyId, "bd", exposure), false);
    assert.equal(await recordMeasurement(journeyId, "bd", exposure, undefined, now), true);
    assert.equal(await recordMeasurement(journeyId, "bd", { ...exposure, nonce: randomUUID(), recommendationVersion: "rules-v1-retry" }, undefined, now), true);
    assert.equal(await db.measurementEvent.count({ where: { journeyId, kind: "EXPERIMENT_EXPOSURE" } }), 1);
    assert.equal((await db.recommendationExperimentAssignment.findUniqueOrThrow({ where: { id: bd.id } })).latencyMs, 126);
    const shopper = randomUUID();
    const key = measurementAccountKey(shopper);
    await db.recommendationPreference.update({ where: { journeyId }, data: { shopperKey: key, associatedAt: new Date() } });
    assert.equal(await enrollRecommendationExperiment("bd", journeyId, now, null), null);
    assert.deepEqual(await enrollRecommendationExperiment("bd", journeyId, now, key), bd);
    assert.deepEqual(await enrollRecommendationExperiment("us", journeyId, now, key), us);
    assert.equal(await recordMeasurement(journeyId, "bd", exposure, undefined, now), false);
    await db.$transaction(async tx => {
      await tx.recommendationPreference.update({ where: { journeyId }, data: { enabled: false } });
      await deleteRecommendationExperimentHistory(journeyId, tx);
    });
    assert.equal(await enrollRecommendationExperiment("bd", journeyId, now, key), null);
    assert.equal(await recordMeasurement(journeyId, "bd", exposure, shopper, now), false);
    assert.equal(await db.recommendationExperimentAssignment.count({ where: { journeyId } }), 0);
    assert.equal(await db.measurementEvent.count({ where: { journeyId } }), 0);
    assert.ok(await db.measurementJourney.findUnique({ where: { id: journeyId } }));
    await db.recommendationPreference.update({ where: { journeyId }, data: { enabled: true, since: new Date(+now + 1) } });
    const renewed = await enrollRecommendationExperiment("bd", journeyId, new Date(+now + 1), key);
    assert.ok(renewed && renewed.id !== bd.id && renewed.variant === bd.variant);
    await revokeMeasurement(token);
    assert.equal(await db.recommendationExperimentAssignment.count({ where: { journeyId } }), 0);
  } finally {
    await revokeMeasurement(token);
  }
});

test("mature BDT bridge and USD native fixture outcomes reconcile separately", async () => {
  const at = (days: number) => new Date(Date.UTC(2025, 4, 15) + days * 86_400_000);
  const id = stableMeasurementId("experiment-report-test", randomUUID());
  const order = stableMeasurementId("experiment-report-order", id);
  const usAssignment = stableMeasurementId("experiment-report-us", id);
  const nativeOrder = randomUUID();
  const attemptId = randomUUID();
  const failedAttemptId = randomUUID();
  const sessionId = randomUUID();
  const booked = at(1);
  try {
    await db.measurementJourney.create({ data: { id, test: true, grantedAt: at(0), expiresAt: at(7) } });
    await db.recommendationExperimentAssignment.create({ data: { id, experimentId: "homepage-recommendations-v1", marketId: "bd",
      journeyId: id, variant: "personalized", assignedAt: at(0), preferenceSince: at(0) } });
    await db.recommendationExperimentAssignment.create({ data: { id: usAssignment, experimentId: "homepage-recommendations-v1", marketId: "us",
      journeyId: id, variant: "control", assignedAt: at(0), preferenceSince: at(0) } });
    await db.bridgeOrder.create({ data: { id: order, authority: "experiment-test", marketId: "bd", currency: "BDT", paymentMethod: "COD",
      createdAt: booked, totalMinor: 12_000, evidence: "fixture", measurementClaimed: true,
      measurement: { create: { id, marketId: "bd", authority: "experiment-test", journeyId: id, sessionId, cartDigest: id,
        issuedAt: at(0), expiresAt: at(2) } },
      events: { create: [
        { id: stableMeasurementId(order, "accept"), kind: "ORDER_ACCEPTED", at: booked, amountMinor: 12_000 },
        { id: stableMeasurementId(order, "deliver"), kind: "ORDER_DELIVERED", at: at(4) },
        { id: stableMeasurementId(order, "collect"), kind: "COD_COLLECTED", at: at(5), amountMinor: 12_000 },
        { id: stableMeasurementId(order, "remit"), kind: "COD_REMITTED", at: at(6), amountMinor: 11_000, grossMinor: 12_000, deductionsMinor: 1_000 },
      ] },
    } });
    for (const [attempt, captured] of [[attemptId, true], [failedAttemptId, false]] as const) {
      await db.checkoutAttempt.create({ data: { id: attempt, createdAt: booked, guestKey: id, requestHash: id,
        marketId: "us", paymentMethod: "PAYPAL", commerceEvidence: "sandbox",
        measurement: { create: { journeyId: id, marketId: "us", sessionId } },
        paypal: { create: { expiresAt: at(7), ...(captured ? { captureId: `capture-${id}` }
          : { providerFailedAt: at(2), providerFailureCode: "DECLINED" }) } },
      } });
    }
    await db.order.create({ data: {
      id: nativeOrder, attemptId, reference: `experiment-report-${nativeOrder}`, marketId: "us", currency: "USD",
      createdAt: booked, measurementTest: true, commerceEvidence: "sandbox", customerName: "Synthetic shopper",
      phone: "0000000000", district: "WA", districtLabel: "Washington", locality: "Seattle", address: "Fixture address",
      deliveryMethod: "fixture", deliveryLabel: "Sandbox delivery", taxLabel: "Sandbox tax",
      subtotalMinor: 1_500, totalMinor: 2_100, discountMinor: 0, deliveryMinor: 600, taxMinor: 0,
      payment: { create: { method: "PAYPAL", status: "PAID", amountMinor: 2_100, currency: "USD", createdAt: at(2) } },
    } });
    const reportDate = at(22);
    const bdDay = marketDay(at(0), marketConfiguration("bd").timeZone);
    const bd = await recommendationExperimentReport({ marketId: "bd", test: true, now: reportDate, from: bdDay, to: bdDay });
    assert.equal(bd.kind, "ready");
    const arm = bd.results.personalized;
    assert.deepEqual([arm.assigned, arm.completed, arm.collected, arm.delivered, arm.codCollected, arm.codRemitted], [1, 1, 12_000n, 1, 1, 1]);
    assert.equal(arm.contribution.total, null);
    const live = await recommendationExperimentReport({ marketId: "bd", test: false, now: reportDate, from: bdDay, to: bdDay });
    assert.equal(live.kind, "ready");
    assert.equal(live.results.personalized.assigned, 0);
    const usDay = marketDay(at(0), marketConfiguration("us").timeZone);
    const us = await recommendationExperimentReport({ marketId: "us", test: true, now: reportDate, from: usDay, to: usDay });
    assert.equal(us.kind, "ready");
    assert.equal(us.results.personalized.assigned, 0);
    assert.deepEqual([us.results.control.assigned, us.results.control.completed, us.results.control.collected,
      us.results.control.paymentFailures], [1, 1, 2_100n, 1]);
    assert.deepEqual(us.results.evidence, ["sandbox"]);
  } finally {
    await db.measurementJourney.deleteMany({ where: { id } });
    await db.bridgeOutcome.deleteMany({ where: { orderId: order } });
    await db.bridgeOrder.deleteMany({ where: { id: order } });
    await db.payment.deleteMany({ where: { orderId: nativeOrder } });
    await db.order.deleteMany({ where: { id: nativeOrder } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: [attemptId, failedAttemptId] } } });
  }
});
