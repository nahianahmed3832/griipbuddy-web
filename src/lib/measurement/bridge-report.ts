import { bridgeOrderLines, bridgeOrderMeasurement, bridgeOrderSelect, projectBridgeOutcomes, type BridgedOrder } from "./bridge-outcomes.ts";
import type { DbReader } from "../db/client.ts";
import type { MarketId } from "../../config/markets.ts";

export async function bridgeOrdersForReport(db: DbReader, input: {
  marketId: MarketId;
  test: boolean;
  fromAt: Date;
  through: Date;
  take: number;
}) {
  return db.bridgeOrder.findMany({
    where: { marketId: input.marketId, evidence: input.test ? { in: ["fixture", "sandbox"] } : "production",
      createdAt: { gte: input.fromAt, lte: input.through } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: input.take, select: bridgeOrderSelect,
  });
}

export function bridgeOrderForReport(row: BridgedOrder, now: Date) {
  const outcomes = projectBridgeOutcomes(row, now);
  const codes = new Set(outcomes.map(event => event.kind));
  return {
    ...row,
    items: bridgeOrderLines(row),
    measurement: bridgeOrderMeasurement(row),
    fulfillmentStatus: codes.has("ORDER_DELIVERED") ? "DELIVERED" : "UNFULFILLED",
    payment: { method: row.paymentMethod, status: codes.has("COD_COLLECTED") ? "COLLECTED"
      : codes.has("ORDER_CANCELLED") ? "VOIDED"
      : codes.has("PAYMENT_PAID") ? "PAID" : row.paymentMethod === "COD" ? "AWAITING_COLLECTION" : "UNPAID" },
    outcomes,
    native: null,
  };
}
