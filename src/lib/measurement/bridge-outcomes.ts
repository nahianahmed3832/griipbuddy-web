import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { marketDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { attachBridgeHandoff, canonicalBridgeLines } from "./bridge-consent.ts";
import { bridgeLines, configuredBridge, OutcomeBridgeError, readSignedBridge, type BridgeEnvelope } from "./bridge-contract.ts";
import { stableMeasurementId } from "./domain.ts";
import type { CommerceOutcome } from "./outcomes.ts";
import { measurementSchemaVersion } from "./schema.ts";

export const bridgeOrderSelect = {
  id: true, authority: true, marketId: true, evidence: true, currency: true, paymentMethod: true, createdAt: true,
  subtotalMinor: true, discountMinor: true, taxMinor: true, deliveryMinor: true, totalMinor: true, lines: true,
  events: { select: { id: true, kind: true, at: true, amountMinor: true, grossMinor: true, deductionsMinor: true } },
  measurement: { select: {
    journeyId: true, sessionId: true, marketId: true, authority: true, journey: { select: { test: true } },
  } },
} satisfies Prisma.BridgeOrderSelect;

export type BridgedOrder = Prisma.BridgeOrderGetPayload<{ select: typeof bridgeOrderSelect }>;

export function bridgeOrderLines(row: Pick<BridgedOrder, "lines">) {
  const parsed = bridgeLines.safeParse(row.lines);
  return parsed.success
    ? canonicalBridgeLines(parsed.data).map(([variantId, quantity]) => ({ variantId, quantity }))
    : [];
}

export function bridgeOrderMeasurement(row: BridgedOrder) {
  const link = row.measurement;
  return link && link.authority === row.authority && link.marketId === row.marketId &&
    link.journey.test === (row.evidence !== "production") ? { journeyId: link.journeyId, sessionId: link.sessionId } : null;
}

export function projectBridgeOutcomes(row: BridgedOrder, cutoff = new Date()): CommerceOutcome[] {
  const link = bridgeOrderMeasurement(row);
  return row.events
    .filter(event => event.at >= row.createdAt && event.at <= cutoff)
    .map(event => ({
      id: event.id, kind: event.kind, at: event.at, schemaVersion: measurementSchemaVersion,
      marketId: row.marketId, currency: row.currency, paymentMethod: row.paymentMethod,
      evidence: row.evidence, test: row.evidence !== "production", source: "external-bridge",
      transactionId: `gb-${stableMeasurementId("bridge-transaction", row.id).slice(0, 40)}`,
      orderId: row.id, amountMinor: event.amountMinor,
      grossMinor: event.grossMinor ?? undefined, deductionsMinor: event.deductionsMinor ?? undefined,
      journeyId: link?.journeyId ?? null, sessionId: link?.sessionId ?? null,
    }));
}

function sameOrder(previous: BridgedOrder, next: BridgeEnvelope["orders"][number]) {
  return previous.currency === next.currency && previous.paymentMethod === next.paymentMethod &&
    +previous.createdAt === +new Date(next.bookedAt) && previous.totalMinor === next.totalMinor &&
    previous.subtotalMinor === (next.subtotalMinor ?? null) && previous.discountMinor === (next.discountMinor ?? null) &&
    previous.taxMinor === (next.taxMinor ?? null) && previous.deliveryMinor === (next.deliveryMinor ?? null) &&
    JSON.stringify(bridgeOrderLines(previous)) === JSON.stringify(
      canonicalBridgeLines(next.lines ?? []).map(([variantId, quantity]) => ({ variantId, quantity })),
    );
}

type StoredOutcome = BridgedOrder["events"][number];

function sameOutcome(stored: StoredOutcome, id: string, event: BridgeEnvelope["orders"][number]["events"][number]) {
  return stored.id === id && +stored.at === +new Date(event.at) && stored.amountMinor === (event.amountMinor ?? null) &&
    stored.grossMinor === (event.grossMinor ?? null) && stored.deductionsMinor === (event.deductionsMinor ?? null);
}

export async function importOutcomeBridge(signed: Buffer) {
  const binding = configuredBridge();
  if (!binding) throw new OutcomeBridgeError("The fixture outcome bridge is disabled or unconfigured.");
  const now = new Date();
  const batch = readSignedBridge(signed, binding, now);
  const scope = [batch.authority, batch.marketId, batch.evidence] as const;
  const db = getDb();
  try {
    return await db.$transaction(async tx => {
      // Serialize batches for this source to keep booking and lifecycle replays atomic.
      const lock = ["griipbuddy-outcome-bridge", ...scope].join(":");
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      let ordersCreated = 0, eventsCreated = 0, linksCreated = 0;
      for (const input of batch.orders) {
        const id = stableMeasurementId("bridge-order", ...scope, input.sourceOrderId);
        const createdAt = new Date(input.bookedAt);
        const previous = await tx.bridgeOrder.findUnique({
          where: { id }, select: { ...bridgeOrderSelect, measurementClaimed: true },
        });
        if (previous) {
          if (!sameOrder(previous, input)) throw new OutcomeBridgeError("Bridge booking conflicts with existing evidence.");
        } else {
          await tx.bridgeOrder.create({
            data: { id, authority: batch.authority, marketId: batch.marketId, evidence: batch.evidence, currency: input.currency,
              paymentMethod: input.paymentMethod, createdAt, subtotalMinor: input.subtotalMinor, discountMinor: input.discountMinor,
              taxMinor: input.taxMinor, deliveryMinor: input.deliveryMinor, totalMinor: input.totalMinor, lines: input.lines ?? undefined },
          });
          ordersCreated++;
        }
        for (const event of input.events) {
          const evidenceId = stableMeasurementId("bridge-outcome", ...scope, event.sourceEventId);
          const amountMinor = event.amountMinor ?? null;
          const grossMinor = event.grossMinor ?? null;
          const deductionsMinor = event.deductionsMinor ?? null;
          const at = new Date(event.at);
          const stored = previous?.events.find(row => row.kind === event.kind);
          if (stored) {
            if (!sameOutcome(stored, evidenceId, event)) {
              throw new OutcomeBridgeError("Bridge transition conflicts with existing evidence.");
            }
            continue;
          }
          await tx.bridgeOutcome.create({
            data: { id: evidenceId, orderId: id, kind: event.kind, at, amountMinor, grossMinor, deductionsMinor },
          });
          eventsCreated++;
        }
        if (!previous?.measurementClaimed && input.lines && input.linkProof &&
            await attachBridgeHandoff(tx, binding, { id, createdAt, lines: input.lines, linkProof: input.linkProof }, now)) linksCreated++;
      }
      return { ordersReceived: batch.orders.length, ordersCreated, eventsCreated, linksCreated };
    }, { timeout: 30_000 });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      throw new OutcomeBridgeError("Bridge source reused a previously assigned evidence identifier.");
    }
    throw error;
  }
}

export async function verifyOutcomeBridge(signed: Buffer) {
  const binding = configuredBridge();
  if (!binding) throw new OutcomeBridgeError("The fixture outcome bridge is disabled or unconfigured.");
  const batch = readSignedBridge(signed, binding);
  const scope = [batch.authority, batch.marketId, batch.evidence] as const;
  const orders = batch.orders.map(input => ({ input, id: stableMeasurementId("bridge-order", ...scope, input.sourceOrderId) }));
  const timeZone = marketConfiguration(batch.marketId).timeZone;
  const persisted = await getDb().bridgeOrder.findMany({
    where: { id: { in: orders.map(order => order.id) }, authority: batch.authority, marketId: batch.marketId, evidence: batch.evidence },
    select: bridgeOrderSelect,
  });
  const byId = new Map(persisted.map(row => [row.id, row]));
  return {
    authority: batch.authority, marketId: batch.marketId, evidence: batch.evidence,
    orders: orders.map(({ input, id }) => {
      const saved = byId.get(id);
      if (!saved || !sameOrder(saved, input) || saved.events.length !== input.events.length) {
        throw new OutcomeBridgeError("Persisted bridge booking or lifecycle differs from the signed export.");
      }
      if (binding.scope === "development-report" && saved.measurement) {
        throw new OutcomeBridgeError("The development report fixture has an unexpected shopper association.");
      }
      return {
        day: marketDay(saved.createdAt, timeZone), currency: saved.currency, totalMinor: saved.totalMinor,
        events: input.events.map(event => {
          const evidenceId = stableMeasurementId("bridge-outcome", ...scope, event.sourceEventId);
          const stored = saved.events.find(row => row.kind === event.kind);
          if (!stored || !sameOutcome(stored, evidenceId, event)) {
            throw new OutcomeBridgeError("Persisted bridge transition differs from the signed export.");
          }
          return { kind: stored.kind, reference: stored.id.slice(0, 12), amountMinor: stored.amountMinor };
        }),
      };
    }),
  };
}
