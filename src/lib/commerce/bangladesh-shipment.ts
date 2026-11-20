import { randomBytes } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.ts";
import { hybridDemoMode } from "../release-config.ts";
import type { MarketId } from "../../config/markets.ts";
import { orderHasAdapter } from "./market-commerce.ts";

export const bangladeshTrackingSummary = { select: { status: true } } satisfies Prisma.BangladeshShipmentDefaultArgs;
export const bangladeshTrackingHistory = {
  select: {
    status: true, carrier: true, trackingReference: true, source: true, statusUpdatedAt: true,
    events: { select: { status: true, recordedAt: true }, orderBy: [{ recordedAt: "asc" }, { status: "asc" }] },
  },
} satisfies Prisma.BangladeshShipmentDefaultArgs;

export type BangladeshTracking = Prisma.BangladeshShipmentGetPayload<typeof bangladeshTrackingHistory>;

export const bangladeshStaffTrackingHistory = {
  select: {
    ...bangladeshTrackingHistory.select,
    events: { ...bangladeshTrackingHistory.select.events, select: { ...bangladeshTrackingHistory.select.events.select, evidence: true } },
  },
} satisfies Prisma.BangladeshShipmentDefaultArgs;

export type BangladeshStaffTracking = Prisma.BangladeshShipmentGetPayload<typeof bangladeshStaffTrackingHistory>;

type TestOrder = { marketId: MarketId; measurementTest: boolean | null; commercialSnapshot?: unknown };

export function devShipmentAvailable(order: TestOrder) {
  return order.measurementTest === true && hybridDemoMode() && orderHasAdapter(order, "fulfillment", "steadfast");
}

export function demoHandoff() {
  return { carrier: "GriipBuddy demo courier", trackingReference: `DEMO-${randomBytes(8).toString("hex").toUpperCase()}` };
}
