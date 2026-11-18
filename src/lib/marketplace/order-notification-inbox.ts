import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { BangladeshShipmentStatus, FulfillmentStatus, OrderCaseKind, OrderCaseStatus } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";

export const orderNoticePageSize = 20;
export const orderNoticeKey = z.string().regex(
  /^(?:order|fulfillment|shipment|case):[0-9a-f-]{36}(?::[a-z_]+)?$/,
).max(64);

export const orderNoticeFilter = z.enum(["all", "orders", "refunds"]);
export type OrderNoticeFilter = z.infer<typeof orderNoticeFilter>;
type NoticeCursor = { at: Date; key: string };
type CommonNotice = {
  key: string;
  orderId: string;
  reference: string;
  at: Date;
  read: boolean;
};
type OrderMilestone = Exclude<FulfillmentStatus, "UNFULFILLED"> | BangladeshShipmentStatus |
  "PLACED" | "CANCELLED" | "CASH_COLLECTED" | "PAYMENT_CONFIRMED" | "RETURNED_TO_STORE";
export type ShopOrderNotice = CommonNotice & (
  { type: "order"; status: OrderMilestone; caseId: null; caseKind: null } |
  { type: "case"; status: OrderCaseStatus; caseId: string; caseKind: OrderCaseKind } |
  { type: "refund"; status: "REFUND_APPROVED" | "REFUND_FAILED" | "REFUND_CONFIRMED"; caseId: string; caseKind: OrderCaseKind }
);

export function readNoticeCursor(value: unknown): NoticeCursor | undefined {
  if (typeof value !== "string" || value.length > 110) return undefined;
  const [date, key, extra] = value.split("~");
  if (extra !== undefined || !z.iso.datetime().safeParse(date).success || !orderNoticeKey.safeParse(key).success) return undefined;
  return { at: new Date(date), key };
}

// Use the records committed by checkout, fulfillment and after-sales. The feed
// includes history after a verified guest claim and never depends on mail delivery.
function noticeSource(shopperId: string, orderId?: string) {
  const orderScope = orderId ? Prisma.sql`AND o."id" = ${orderId}::uuid` : Prisma.empty;
  return Prisma.sql`
    WITH owned AS (
      SELECT o."id", o."reference", o."createdAt", o."cancelledAt"
      FROM "Order" o
      WHERE o."shopperId" = ${shopperId} AND o."marketId" = 'bd' ${orderScope}
    ), notices("key", "orderId", "type", "status", "at", "caseId", "caseKind") AS (
      SELECT 'order:' || o."id" || ':' || lower(state.status), o."id", 'order', state.status, state.at, NULL::uuid, NULL::text
      FROM owned o
      CROSS JOIN LATERAL (VALUES ('PLACED', o."createdAt"), ('CANCELLED', o."cancelledAt")) AS state(status, at)
      WHERE state.at IS NOT NULL

      UNION ALL
      SELECT 'fulfillment:' || f."id", o."id", 'order', f."status"::text, f."createdAt", NULL, NULL
      FROM owned o JOIN "FulfillmentEvent" f ON f."orderId" = o."id"
      WHERE f."type" = 'STATUS_CHANGED' AND f."status" <> 'UNFULFILLED'
        AND (f."status" NOT IN ('SHIPPED', 'DELIVERED') OR NOT EXISTS (
          SELECT 1 FROM "BangladeshShipmentEvent" s
          WHERE s."orderId" = o."id" AND
            ((f."status" = 'SHIPPED' AND s."status" = 'IN_TRANSIT') OR (f."status" = 'DELIVERED' AND s."status" = 'DELIVERED'))
        ))

      UNION ALL
      SELECT 'shipment:' || o."id" || ':' || lower(s."status"::text), o."id", 'order',
        s."status"::text, s."recordedAt", NULL, NULL
      FROM owned o JOIN "BangladeshShipmentEvent" s ON s."orderId" = o."id"

      UNION ALL
      SELECT 'order:' || o."id" || ':returned', o."id", 'order', 'RETURNED_TO_STORE', r."receivedAt", NULL, NULL
      FROM owned o JOIN "BangladeshRefusedParcelReceipt" r ON r."orderId" = o."id"

      UNION ALL
      SELECT 'order:' || o."id" || ':paid', o."id", 'order',
        CASE p."method" WHEN 'COD' THEN 'CASH_COLLECTED' ELSE 'PAYMENT_CONFIRMED' END,
        COALESCE(p."collectedAt", p."createdAt"), NULL, NULL
      FROM owned o JOIN "Payment" p ON p."orderId" = o."id"
      WHERE (p."method" = 'COD' AND p."collectedAt" IS NOT NULL)
        OR (p."method" <> 'COD' AND p."status" IN ('PAID', 'REFUND_PENDING', 'REFUNDED')
          AND (p."collectedAt" IS NOT NULL OR p."method" = 'SSLCOMMERZ'))

      UNION ALL
      SELECT 'case:' || e."id", o."id",
        CASE WHEN e."refundConfirmed" OR e."status" IN ('REFUND_APPROVED', 'REFUND_FAILED') THEN 'refund' ELSE 'case' END,
        CASE WHEN e."refundConfirmed" THEN 'REFUND_CONFIRMED' ELSE e."status"::text END,
        e."createdAt", c."id", c."kind"::text
      FROM owned o JOIN "OrderCase" c ON c."orderId" = o."id"
      JOIN "OrderCaseEvent" e ON e."caseId" = c."id"
      LEFT JOIN "OrderCaseEvent" prev ON prev."caseId" = e."caseId" AND prev."revision" = e."revision" - 1
      WHERE e."refundConfirmed" OR e."status" IS DISTINCT FROM prev."status"
    )
  `;
}

export async function shopOrderNotifications(shopperId: string, { orderId, filter, before }: {
  orderId?: string; filter: OrderNoticeFilter; before?: NoticeCursor;
}) {
  const category = filter === "all" ? Prisma.empty : filter === "refunds"
    ? Prisma.sql`AND n."type" = 'refund'` : Prisma.sql`AND n."type" <> 'refund'`;
  const cursor = before ? Prisma.sql`AND (n."at", n."key") < (${before.at}::timestamp, ${before.key})` : Prisma.empty;
  const rows = await getDb().$queryRaw<ShopOrderNotice[]>`
    ${noticeSource(shopperId, orderId)}
    SELECT n.*, o."reference", (r."eventKey" IS NOT NULL) AS "read"
    FROM notices n JOIN owned o ON o."id" = n."orderId"
    LEFT JOIN "ShopperOrderNotificationRead" r ON r."shopperId" = ${shopperId} AND r."eventKey" = n."key"
    WHERE TRUE ${category} ${cursor}
    ORDER BY n."at" DESC, n."key" DESC
    LIMIT ${orderNoticePageSize + 1}
  `;
  const notices = rows.slice(0, orderNoticePageSize);
  const last = notices.at(-1);
  return { notices, next: last && rows.length > orderNoticePageSize ? `${last.at.toISOString()}~${last.key}` : null };
}

export async function markShopOrderNotificationsRead(shopperId: string, keys: string[]) {
  if (!keys.length) return;
  await getDb().$executeRaw`
    ${noticeSource(shopperId)}
    INSERT INTO "ShopperOrderNotificationRead" ("shopperId", "orderId", "eventKey")
    SELECT ${shopperId}, "orderId", "key" FROM notices WHERE "key" IN (${Prisma.join(keys)})
    ON CONFLICT ("shopperId", "eventKey") DO NOTHING
  `;
}
