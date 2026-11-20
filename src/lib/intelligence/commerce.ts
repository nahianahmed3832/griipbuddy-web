import type { DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { bridgeOrderLines, bridgeOrderSelect, projectBridgeOutcomes } from "../measurement/bridge-outcomes.ts";
import type { ContributionRecord } from "../measurement/contribution.ts";
import { commerceOutcomeSelect, failedPaymentAttempts, projectCommerceOutcomes, type CommerceOutcome } from "../measurement/outcomes.ts";
import type { IntelligenceInput, IntelligenceWindow } from "./types.ts";
import { intelligenceBatch } from "./window.ts";

export type IntelligenceOrder = {
  at: Date;
  updatedAt?: Date;
  lines: { variantId: string; quantity: number; netMinor: number | null; discountMinor: number | null }[];
  returned: { variantId: string; quantity: number; at: Date }[];
  outcomes: CommerceOutcome[];
  verified: ContributionRecord | null;
  source: string;
  evidence: "production" | "sandbox" | "fixture" | "unknown";
};

export async function readIntelligenceCommerce(db: DbReader, input: IntelligenceInput, window: IntelligenceWindow, onlyBookings = false) {
  const { marketId, test, productId, variantId } = input;
  const currency = marketConfiguration(marketId).currency;
  const period = { gte: window.fromAt, lt: window.until };
  const cutoff = new Date(+window.until - 1);
  const take = intelligenceBatch + 1;
  const catalogScope = { ...(productId && { variant: { productId } }), ...(variantId && { variantId }) };
  const explicit = Boolean(productId || variantId);
  const native = await db.order.findMany({
    where: { marketId, currency, measurementTest: test,
      ...(!test && { OR: [{ commerceEvidence: "production" }, { commerceEvidence: null }] }),
      NOT: [{ measurement: { journey: { automated: true } } }, { attempt: { measurement: { journey: { automated: true } } } }],
      ...(explicit && { items: { some: catalogScope } }),
      ...(onlyBookings ? { createdAt: period } : { AND: [{ OR: [
        { createdAt: period }, { cancelledAt: period }, { events: { some: { type: "STATUS_CHANGED", status: "DELIVERED", createdAt: period } } },
        { payment: { OR: [{ createdAt: period }, { collectedAt: period }] } }, { codRemittances: { some: { createdAt: period } } },
        { cases: { some: { OR: [{ createdAt: period }, { returnReceivedAt: period }] } } },
        { parcels: { some: { OR: [{ receivedAt: period }, { events: { some: { status: "REFUSED", recordedAt: period } } }] } } },
        { bangladeshShipment: { events: { some: { status: "REFUSED", recordedAt: period } } } },
        { bangladeshRefusedParcelReceipt: { receivedAt: period } },
      ] }] }),
    }, take, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { ...commerceOutcomeSelect,
      items: { select: { ...commerceOutcomeSelect.items.select, lineTotalMinor: true, couponDiscountMinor: true, prepaidDiscountMinor: true } },
      cases: { ...commerceOutcomeSelect.cases, select: { ...commerceOutcomeSelect.cases.select,
        returnLines: { select: { quantity: true, orderItem: { select: { variantId: true } } } } } },
      parcels: { select: { ...commerceOutcomeSelect.parcels.select,
        items: { select: { quantity: true, orderItem: { select: { variantId: true } } } } } },
    },
  });
  const bridge = await db.bridgeOrder.findMany({
    where: { marketId, currency, evidence: test ? { in: ["fixture", "sandbox"] } : "production",
      NOT: { measurement: { journey: { automated: true } } },
      ...(onlyBookings ? { createdAt: period } : { OR: [{ createdAt: period }, { events: { some: { at: period } } }] }),
    }, take, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: bridgeOrderSelect,
  });
  const failures = onlyBookings ? [] : await failedPaymentAttempts(db, { marketId, test, fromAt: window.fromAt, until: window.until, take });
  const automated = failures.length ? await db.measurementJourney.findMany({
    where: { id: { in: [...new Set(failures.flatMap(event => event.journeyId ?? []))] }, automated: true }, select: { id: true },
  }) : [];
  const knownBots = new Set(automated.map(row => row.id));
  const unclassified = onlyBookings ? 0 : await db.order.count({ where: { marketId, currency, measurementTest: null, createdAt: period,
    ...(explicit && { items: { some: catalogScope } }) } });
  const within = (at: Date) => at >= window.fromAt && at < window.until;
  const mapped: IntelligenceOrder[] = native.map(order => ({
    at: order.createdAt, updatedAt: order.updatedAt, source: "native fulfillment and payment adapters", evidence: order.commerceEvidence ?? "unknown",
    verified: order.contributionEvidence,
    lines: order.items.map(line => ({ variantId: line.variantId, quantity: line.quantity, netMinor: line.lineTotalMinor,
      discountMinor: line.unitDiscountMinor * line.quantity + line.couponDiscountMinor + line.prepaidDiscountMinor })),
    returned: [
      ...order.cases.flatMap(entry => entry.returnReceivedAt && within(entry.returnReceivedAt) ? entry.returnLines.map(line => ({
        variantId: line.orderItem.variantId, quantity: line.quantity, at: entry.returnReceivedAt!,
      })) : []),
      ...order.parcels.flatMap(parcel => parcel.receivedAt && within(parcel.receivedAt) ? parcel.items.map(line => ({
        variantId: line.orderItem.variantId, quantity: line.quantity, at: parcel.receivedAt!,
      })) : []),
    ],
    outcomes: projectCommerceOutcomes(order, cutoff).filter(event => within(event.at)),
  }));
  for (const order of bridge) mapped.push({
    at: order.createdAt, source: `legacy bridge (${order.authority})`, evidence: order.evidence, verified: null,
    lines: bridgeOrderLines(order).map(line => ({ ...line, netMinor: null, discountMinor: null })), returned: [],
    outcomes: projectBridgeOutcomes(order, cutoff).filter(event => within(event.at)),
  });
  return { orders: mapped, paymentFailures: failures.filter(event => !event.journeyId || !knownBots.has(event.journeyId)), unclassified,
    overflow: native.length + bridge.length > intelligenceBatch || failures.length > intelligenceBatch };
}
