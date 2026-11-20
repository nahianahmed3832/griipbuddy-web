import { z } from "zod";
import type { MarketCode, Prisma } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
import { legacyLocationId } from "../commerce/location-inventory.ts";
import type { MigrationIssue } from "./contracts.ts";

const paymentLine = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().positive(),
  locationId: z.string().min(1).nullish(),
});

type PaymentScope = {
  attemptId: string;
  marketId: MarketCode | null;
  method: "PAYPAL" | "SSLCOMMERZ";
  state: string;
  hasHold: boolean;
  hasLocations: boolean;
  lines: Prisma.JsonValue;
  expiresAt: Date;
};

function pendingPayments(db: DbReader) {
  // Inspect only the saved item IDs and allocations. Customer and provider details
  // stay in the legacy records and never appear in migration evidence.
  return db.$queryRaw<PaymentScope[]>`
    WITH payment_sessions AS (
      SELECT 'PAYPAL'::text AS method, "attemptId", state::text, "expiresAt", checkout, quote, "stockAllocations",
        state::text IN ('CAPTURING', 'COMPLETED') AS "hasHold"
      FROM "PayPalCheckout" WHERE state::text <> 'CANCELLED'
      UNION ALL
      SELECT 'SSLCOMMERZ'::text AS method, "attemptId", state::text, "expiresAt", checkout, quote, "stockAllocations",
        true AS "hasHold"
      FROM "PrepaidCheckout" WHERE state::text <> 'CLOSED'
    ), source AS (
      SELECT s."attemptId", a."marketId", s.method, s.state, s."expiresAt", s."hasHold",
        (s."stockAllocations" IS NOT NULL AND s."stockAllocations" <> 'null'::jsonb) AS "hasLocations",
        CASE
          WHEN s."stockAllocations" IS NOT NULL AND s."stockAllocations" <> 'null'::jsonb THEN s."stockAllocations"
          WHEN jsonb_typeof(s.quote -> 'lines') = 'array' THEN s.quote -> 'lines'
          ELSE s.checkout -> 'items'
        END AS payload
      FROM payment_sessions s JOIN "CheckoutAttempt" a ON a.id = s."attemptId"
      WHERE NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."attemptId" = s."attemptId")
    )
    SELECT s."attemptId", s."marketId", s.method, s.state, s."expiresAt", s."hasHold", s."hasLocations",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('variantId', line -> 'variantId', 'quantity', line -> 'quantity',
          'locationId', line -> 'locationId') ORDER BY position)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload) = 'array' THEN s.payload ELSE '[]'::jsonb END)
          WITH ORDINALITY AS entry(line, position)
      ), '[]'::jsonb) AS lines
    FROM source s ORDER BY s."attemptId", s.method
  `;
}

export async function inspectCommerceRisk(db: DbReader, variantIds: readonly string[]) {
  const issues: MigrationIssue[] = [];
  const affected = new Set(variantIds);
  const quantities = new Map(variantIds.map(variantId => [variantId, { variantId, reserved: 0, allocated: 0 }]));
  const ids = [...affected];

  const payments = ids.length ? (await pendingPayments(db)).flatMap(session => {
    const parsed = z.array(paymentLine).min(1).safeParse(session.lines);
    const missingScope = !parsed.success || (session.hasHold && session.hasLocations && parsed.data.some(line => !line.locationId));
    if (missingScope) {
      issues.push({ code: "unattributed_payment", reference: session.attemptId,
        message: "A pending provider session lacks complete saved variant or allocation evidence. Reconcile it before migrating stock." });
      return [{ ...session, lines: [] as z.output<typeof paymentLine>[], unattributed: true }];
    }
    const lines = parsed.data.filter(line => affected.has(line.variantId));
    if (!lines.length) return [];
    if (session.hasHold) for (const line of lines) quantities.get(line.variantId)!.reserved += line.quantity;
    issues.push({ code: "open_payment", reference: session.attemptId,
      message: "A pending provider session references this group. Drain or map the original checkout and allocation before migrating." });
    return [{ ...session, lines: lines.map(line => ({ ...line, locationId: line.locationId ?? legacyLocationId })), unattributed: false }];
  }) : [];

  const orders = await db.orderItem.findMany({
    where: { variantId: { in: ids }, order: { status: "PLACED", fulfillmentStatus: { not: "DELIVERED" } } },
    select: {
      id: true, variantId: true, quantity: true, marketplaceShopId: true,
      order: { select: { id: true, marketId: true, status: true, fulfillmentStatus: true,
        payment: { select: { method: true, status: true } },
        inventoryReservation: { select: { id: true } },
        bangladeshShipment: { select: { status: true } } } },
      parcelItems: { orderBy: { parcelId: "asc" }, select: { quantity: true, parcel: {
        select: { id: true, locationId: true, status: true, receivedAt: true, returnDisposition: true },
      } } },
    },
    orderBy: { id: "asc" },
  });

  for (const line of orders) {
    if (!line.order.inventoryReservation) {
      const undispatched = line.parcelItems.length
        ? line.parcelItems.filter(item => item.parcel.status === "PLANNED").reduce((total, item) => total + item.quantity, 0)
        : line.order.fulfillmentStatus === "SHIPPED" || line.order.bangladeshShipment ? 0 : line.quantity;
      quantities.get(line.variantId)!.allocated += undispatched;
    }
    issues.push({ code: "open_order", reference: line.id,
      message: "An open order has stock or fulfilment provenance in this group. Drain it or approve an explicit allocation mapping first." });
  }

  const returns = await db.orderCaseReturnLine.findMany({
    where: {
      OR: [{ orderItem: { variantId: { in: ids } } }, { replacementVariantId: { in: ids } }],
      orderCase: { status: { notIn: ["DECLINED", "RESOLVED", "WITHDRAWN", "EXCHANGE_SHIPPED"] } },
    },
    select: {
      caseId: true, orderItemId: true, replacementVariantId: true, quantity: true, orderItem: { select: { variantId: true } },
      orderCase: { select: { orderId: true, status: true, kind: true, returnDisposition: true, returnReceivedAt: true } },
    },
    orderBy: [{ caseId: "asc" }, { orderItemId: "asc" }],
  });
  for (const line of returns) issues.push({ code: "open_return", reference: line.caseId,
    message: "An open return or replacement references this group. Inspect the original warehouse and restocking status first." });

  const allocations = await db.inventoryAllocation.findMany({
    where: { pool: { variantId: { in: ids } }, reservation: { state: { in: ["HELD", "COMMITTED", "PAYMENT_EXCEPTION"] } } },
    select: {
      id: true, poolId: true, quantity: true, dispatched: true, returned: true,
      pool: { select: { variantId: true, ownerId: true, locationId: true } },
      reservation: { select: { id: true, attemptId: true, marketId: true, orderId: true, state: true, expiresAt: true } },
    },
    orderBy: { id: "asc" },
  });
  for (const allocation of allocations) {
    const quantity = quantities.get(allocation.pool.variantId)!;
    if (allocation.reservation.state === "HELD") quantity.reserved += allocation.quantity;
    if (allocation.reservation.state === "COMMITTED") quantity.allocated += allocation.quantity - allocation.dispatched;
    issues.push({ code: "connected_allocation", reference: allocation.id,
      message: "A connected hold or allocation already exists in this group. Keep its existing writer and resolve the overlap." });
  }

  return {
    issues,
    source: { payments, orders, returns, allocations },
    quantities: [...quantities.values()].sort((a, b) => a.variantId.localeCompare(b.variantId, "en")),
  };
}
