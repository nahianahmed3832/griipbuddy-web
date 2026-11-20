import assert from "node:assert/strict";
import test from "node:test";
import type { CommerceOutcome } from "../src/lib/measurement/outcomes.ts";
import { browserMeasurementSchema } from "../src/lib/measurement/schema.ts";
import { experimentResults, type ExperimentMember, type ExperimentOrder, type ExperimentObservation } from "../src/lib/catalog/recommendation-experiment-analysis.ts";
import { recommendationExperimentVariant } from "../src/lib/catalog/recommendation-experiment-plan.ts";

const day = 86_400_000;
const at = (distance: number) => new Date(Date.UTC(2026, 9, 1) + distance * day);
const member = (id: string, variant: ExperimentMember["variant"], offset = 0): ExperimentMember => ({
  id, journeyId: id, variant, assignedAt: at(offset), expiresAt: at(offset + 6), latencyMs: null,
});
const order = (id: string, journeyId: string, events: [CommerceOutcome["kind"], number, number?][], overrides: Pick<ExperimentOrder, "marketId" | "currency"> = { marketId: "bd", currency: "BDT" }): ExperimentOrder => ({
  id, journeyId, ...overrides, createdAt: at(1),
  outcomes: [["ORDER_ACCEPTED", 1] as const, ...events].map(([kind, offset, amountMinor]) => ({
    id: `${id}-${kind}`, kind, at: at(offset), schemaVersion: 1, ...overrides, journeyId, orderId: id,
    sessionId: null, transactionId: null, test: true, evidence: overrides.marketId === "bd" ? "fixture" : "sandbox",
    amountMinor: amountMinor ?? null, paymentMethod: overrides.marketId === "bd" ? "COD" : "PAYPAL",
  })),
});

test("assignment is deterministic and separately bucketed by market", () => {
  const ids = Array.from({ length: 100 }, (_, index) => `synthetic-journey-${index}`);
  const bd = ids.map(id => recommendationExperimentVariant("bd", id));
  const us = ids.map(id => recommendationExperimentVariant("us", id));
  assert.deepEqual(bd, ids.map(id => recommendationExperimentVariant("bd", id)));
  assert.notDeepEqual(bd, us);
  assert.equal(new Set(bd).size, 2);
  assert.equal(new Set(us).size, 2);
});

test("visibility is a separate schema observation with typed assignment context", () => {
  const exposure = {
    action: "EXPERIMENT_EXPOSURE", version: 1, marketId: "us", placement: "recommended", at: at(0).toISOString(),
    nonce: "98415a50-8b35-4f98-985f-dfd7fd37fa74", sessionId: "f5363022-0486-4426-8ed8-a2a8b162dc4c",
    recommendationVersion: "featured-v1", experimentAssignment: "valid-assignment-shape",
  };
  assert.ok(browserMeasurementSchema.safeParse(exposure).success);
  assert.ok(!browserMeasurementSchema.safeParse({ ...exposure, experimentAssignment: undefined }).success);
  assert.ok(!browserMeasurementSchema.safeParse({ ...exposure, recommendationVersion: "n/a" }).success);
});

test("market reports use mature intent-to-treat journeys and verified local cash", () => {
  const control = member("control", "control");
  const collected = member("collected", "personalized");
  const recent = member("recent", "personalized", 17);
  const crossMarket = order("mixed-market", collected.id, [["PAYMENT_PAID", 2, 98_000]], { marketId: "us", currency: "USD" });
  const bookedAndDelivered = order("booked-uncollected", control.journeyId, [["ORDER_DELIVERED", 3]]);
  const paid = order("cash-collected", collected.journeyId, [["ORDER_DELIVERED", 4], ["COD_COLLECTED", 5, 12_000],
    ["COD_REMITTED", 6, 11_500], ["RETURN_RECEIVED", 20]]);
  const lateCollection = order("late-collection", control.journeyId, [["COD_COLLECTED", 16, 50_000]]);
  const lateBooking = order("outside-consent", control.journeyId, [["COD_COLLECTED", 10, 60_000]]);
  lateBooking.createdAt = at(6.1);
  lateBooking.outcomes[0].at = lateBooking.createdAt;
  const exposure: ExperimentObservation = { kind: "EXPERIMENT_EXPOSURE", journeyId: collected.journeyId, at: at(1),
    experimentAssignment: collected.id, recommendationVersion: "rules-v1-example", homepageConfig: "homepage-v1" };
  const result = experimentResults({ marketId: "bd", test: true, currency: "BDT", now: at(21),
    members: [control, collected, recent], orders: [bookedAndDelivered, lateBooking, paid, lateCollection, crossMarket],
    observations: [exposure, exposure, { ...exposure, journeyId: control.journeyId },
      { ...exposure, kind: "CHECKOUT_FAILURE" }],
  });
  assert.equal(result.control.completed, 0);
  assert.equal(result.control.collected, 0n);
  assert.equal(result.control.matureOrders, 2);
  assert.equal(result.control.delivered, 1);
  assert.equal(result.control.codCollected, 1);
  assert.equal(result.control.exposed, 0);
  assert.equal(result.personalized.exposed, 1);
  assert.equal(result.personalized.completed, 1);
  assert.equal(result.personalized.collected, 12_000n);
  assert.equal(result.personalized.codRemitted, 1);
  assert.equal(result.personalized.returns, 1);
  assert.equal(result.personalized.awaitingCollection, 1);
  assert.equal(result.personalized.awaitingFulfillment, 1);
  assert.equal(result.personalized.checkoutErrors, 1);
  assert.equal(result.personalized.contribution.total, null);
  assert.deepEqual(result.evidence, ["fixture"]);
  assert.equal(result.interpretation, "insufficient-sample");

  const usd = experimentResults({ marketId: "us", test: true, currency: "USD", now: at(21),
    members: [collected], observations: [], orders: [crossMarket, paid] });
  assert.equal(usd.personalized.completed, 1);
  assert.equal(usd.personalized.collected, 98_000n);
  assert.deepEqual(usd.evidence, ["sandbox"]);
});
