import { Prisma } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
import { migrationDigest, type MigrationIssue } from "./contracts.ts";

export async function inspectLegacyHistory(db: DbReader, variantIds: readonly string[], productIds: readonly string[] = []) {
  const variants = [...new Set(variantIds)].sort();
  const products = [...new Set(productIds)].sort();
  const lines = await db.orderItem.findMany({
    where: { variantId: { in: variants } },
    orderBy: { id: "asc" },
    select: {
      id: true, orderId: true, variantId: true, sku: true, productName: true, variantName: true, personalization: true,
      marketplaceShopId: true, quantity: true, currency: true, unitPriceMinor: true, unitDiscountMinor: true,
      couponDiscountMinor: true, prepaidDiscountMinor: true, lineTotalMinor: true,
    },
  });
  const orderIds = [...new Set(lines.map(line => line.orderId))];
  const orders = await db.order.findMany({
    where: { id: { in: orderIds } }, orderBy: { id: "asc" },
    select: {
      id: true, reference: true, attemptId: true, marketId: true, currency: true, status: true, fulfillmentStatus: true,
      carrier: true, trackingReference: true, taxLabel: true, subtotalMinor: true, discountMinor: true,
      deliveryMinor: true, taxMinor: true, totalMinor: true, couponDiscountMinor: true, prepaidDiscountMinor: true,
      commerceEvidence: true, commercialSnapshot: true,
      payment: { select: { method: true, status: true, currency: true, amountMinor: true, collectedAt: true } },
      attempt: { select: {
        marketId: true, paymentMethod: true, commerceEvidence: true, commercialSnapshot: true,
        paypal: { select: { providerOrderId: true, captureId: true, refundId: true, state: true } },
        prepaid: { select: { providerId: true, bankTransactionId: true, state: true } },
      } },
      bangladeshShipment: { select: { carrier: true, trackingReference: true, status: true } },
      bangladeshRefusedParcelReceipt: { select: { receivedAt: true, disposition: true, restockedUnits: true } },
      events: { orderBy: { id: "asc" }, select: { id: true, status: true, type: true, createdAt: true } },
      cases: { orderBy: { id: "asc" }, select: { id: true, kind: true, status: true, revision: true,
        returnDisposition: true, returnReceivedAt: true, pickupReference: true, refundAmountMinor: true,
        replacementTrackingReference: true,
        events: { orderBy: { revision: "asc" }, select: { status: true, revision: true, createdAt: true } },
      } },
    },
  });
  const parcelLines = await db.orderParcelItem.findMany({
    where: { orderItemId: { in: lines.map(line => line.id) } },
    orderBy: [{ parcelId: "asc" }, { orderItemId: "asc" }],
    select: { parcelId: true, orderItemId: true, quantity: true, parcel: { select: {
      orderId: true, locationId: true, locationName: true, status: true, trackingReference: true, carrier: true,
      receivedAt: true, returnDisposition: true,
    } } },
  });
  const returnLines = await db.orderCaseReturnLine.findMany({
    where: { OR: [
      { orderItemId: { in: lines.map(line => line.id) } },
      { replacementVariantId: { in: variants } },
    ] },
    orderBy: [{ caseId: "asc" }, { orderItemId: "asc" }],
    select: {
      caseId: true, orderItemId: true, quantity: true, replacementVariantId: true, replacementVariantName: true,
      orderItem: { select: { orderId: true, variantId: true } },
      orderCase: { select: {
        orderId: true, kind: true, status: true, revision: true, returnReceivedAt: true, returnDisposition: true,
        pickupReference: true, refundAmountMinor: true, replacementTrackingReference: true,
      } },
    },
  });
  const favorites = await db.shopperFavorite.findMany({
    where: { productId: { in: products } }, select: { shopperId: true, productId: true },
    orderBy: [{ productId: "asc" }, { shopperId: "asc" }],
  });
  const listItems = await db.shopperListItem.findMany({
    where: { productId: { in: products } }, select: { listId: true, productId: true },
    orderBy: [{ productId: "asc" }, { listId: "asc" }],
  });
  const watches = await db.shopperVariantWatch.findMany({
    where: { variantId: { in: variants } }, select: { id: true, variantId: true, marketId: true },
    orderBy: { id: "asc" },
  });
  const carts = variants.length ? await db.$queryRaw<{ shopperId: string; items: Prisma.JsonValue; saved: Prisma.JsonValue }[]>`
    SELECT "shopperId", items, saved FROM "ShopperCart"
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        (CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) ||
        (CASE WHEN jsonb_typeof(saved) = 'array' THEN saved ELSE '[]'::jsonb END)
      ) AS entry(line)
      WHERE line->>'variantId' IN (${Prisma.join(variants)})
    ) ORDER BY "shopperId"
  ` : [];

  const issues: MigrationIssue[] = [];
  const ordersById = new Set(orders.map(order => order.id));
  const itemsById = new Map(lines.map(line => [line.id, line]));
  for (const line of lines) {
    if (!ordersById.has(line.orderId)) issues.push({
      code: "historical-order-orphan", reference: line.variantId, message: "A purchased line is missing its original order.",
    });
  }
  for (const parcelLine of parcelLines) {
    const line = itemsById.get(parcelLine.orderItemId);
    if (line?.orderId !== parcelLine.parcel.orderId) issues.push({
      code: "historical-parcel-owner", reference: line?.variantId ?? "parcel",
      message: "A packing line refers to a purchased item from a different order.",
    });
  }
  for (const returnLine of returnLines) {
    if (returnLine.orderItem.orderId !== returnLine.orderCase.orderId) issues.push({
      code: "historical-return-owner", reference: returnLine.orderItem.variantId,
      message: "A return line refers to a purchased item from a different order.",
    });
  }
  // Hash the complete scope. Never return purchased text, account IDs, or provider references in reports.
  const digest = migrationDigest({ lines, orders, parcelLines, returnLines, favorites, listItems, watches, carts });
  return {
    digest, issues, counts: {
      orders: orders.length, orderItems: lines.length, parcelItems: parcelLines.length, returnLines: returnLines.length,
      orderCases: new Set([...orders.flatMap(order => order.cases.map(item => item.id)), ...returnLines.map(line => line.caseId)]).size,
      payments: orders.filter(order => order.payment).length,
      providerSessions: orders.filter(order => order.attempt.paypal || order.attempt.prepaid).length,
      favorites: favorites.length, listItems: listItems.length, variantWatches: watches.length, carts: carts.length,
    },
  };
}
