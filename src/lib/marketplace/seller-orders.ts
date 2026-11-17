import { Prisma } from "../../generated/prisma/client.ts";
import type { FulfillmentStatus, OrderStatus } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";
import type { SellerOrderRange } from "./seller-order-range.ts";
import { nextSellerPreparation, sellerPaymentAllowsPreparation, sellerPreparationInput, sellerPreparationLabels } from "./seller-preparation.ts";
import { fulfillmentLabels } from "../commerce/labels.ts";

const pageSize = 20;
const csvLimit = 10_000;

export class SellerOrderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Every item query uses the shop snapshot attached when the order was placed.
// A catalog change must not change which seller can see an order.
function sellerItemScope(shopId: string) {
  return { marketplaceShopId: shopId } satisfies Prisma.OrderItemWhereInput;
}

export function sellerShop(shopperId: string) {
  return getDb().marketplaceShop.findUnique({
    where: { ownerId: shopperId },
    select: { id: true, name: true },
  });
}

export async function sellerOrderPage(shopId: string, range: SellerOrderRange, page: number) {
  const db = getDb();
  const items = sellerItemScope(shopId);
  const date = { gte: range.start, lt: range.endExclusive };
  const orderScope = { createdAt: date, items: { some: items } };
  const [orders, placed, totals] = await Promise.all([
    db.order.findMany({
      where: orderScope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
      select: {
        id: true,
        reference: true,
        createdAt: true,
        status: true,
        fulfillmentStatus: true,
        marketId: true,
        payment: { select: { method: true, status: true } },
        items: {
          where: items,
          orderBy: { id: "asc" },
          select: {
            id: true, productName: true, variantName: true, sku: true, quantity: true,
            lineTotalMinor: true, personalization: true,
          },
        },
        sellerFulfillments: { where: { shopId }, select: { status: true, updatedAt: true } },
      },
    }),
    db.order.count({ where: { ...orderScope, status: "PLACED" } }),
    db.orderItem.groupBy({
      by: ["currency"],
      where: { ...items, order: { createdAt: date, status: "PLACED" } },
      _sum: { quantity: true, lineTotalMinor: true },
      orderBy: { currency: "asc" },
    }),
  ]);

  return {
    orders: orders.slice(0, pageSize),
    hasNext: orders.length > pageSize,
    placed,
    units: totals.reduce((sum, row) => sum + (row._sum.quantity ?? 0), 0),
    merchandise: totals.map(row => ({ currency: row.currency, amountMinor: row._sum.lineTotalMinor ?? 0 })),
  };
}

export async function advanceSellerPreparation(shopperId: string, input: unknown) {
  const parsed = sellerPreparationInput.safeParse(input);
  if (!parsed.success) throw new SellerOrderError(400, "Choose a valid preparation step.");
  const { orderId, next } = parsed.data;

  return getDb().$transaction(async tx => {
    // Use the same Order row lock as staff fulfillment and cancellation.
    // It also serializes simultaneous requests from the same seller.
    const [order] = await tx.$queryRaw<{ shopId: string; status: OrderStatus; fulfillmentStatus: FulfillmentStatus }[]>`
      SELECT s."id" AS "shopId", o."status", o."fulfillmentStatus"
      FROM "Order" o
      JOIN "MarketplaceShop" s ON s."ownerId" = ${shopperId}
      WHERE o."id" = ${orderId}::uuid
        AND EXISTS (
          SELECT 1 FROM "OrderItem" i
          WHERE i."orderId" = o."id" AND i."marketplaceShopId" = s."id"
        )
      FOR UPDATE OF o
    `;
    if (!order) throw new SellerOrderError(404, "Order not found.");
    const payment = await tx.payment.findUnique({ where: { orderId }, select: { method: true, status: true } });
    if (!sellerPaymentAllowsPreparation(payment)) throw new SellerOrderError(409, "This order is not ready for preparation.");
    const key = { orderId, shopId: order.shopId };
    const where = { orderId_shopId: key };
    const previous = await tx.marketplaceSellerFulfillment.findUnique({ where, select: { status: true } });
    if (previous?.status === next) return { status: next };
    if (nextSellerPreparation(order.status, order.fulfillmentStatus, previous?.status ?? null) !== next) {
      throw new SellerOrderError(409, "That step is no longer available. Refresh the order and try again.");
    }
    return tx.marketplaceSellerFulfillment.upsert({
      where,
      create: { ...key, status: next },
      update: { status: next },
      select: { status: true },
    });
  });
}

// Spreadsheet applications can evaluate a quoted CSV cell as a formula.
function csvCell(value: string | number) {
  const text = String(value);
  const safe = typeof value === "string" && (/^\s*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function sellerOrdersCsv(shopId: string, range: SellerOrderRange) {
  const items = await getDb().orderItem.findMany({
    where: { ...sellerItemScope(shopId), order: { createdAt: { gte: range.start, lt: range.endExclusive } } },
    orderBy: [{ order: { createdAt: "desc" } }, { orderId: "desc" }, { id: "asc" }],
    take: csvLimit + 1,
    select: {
      productName: true, variantName: true, sku: true, quantity: true, lineTotalMinor: true, currency: true,
      order: {
        select: {
          reference: true, createdAt: true, status: true, fulfillmentStatus: true,
          sellerFulfillments: { where: { shopId }, select: { status: true } },
        },
      },
    },
  });

  if (items.length > csvLimit) {
    throw new SellerOrderError(422, "This export has more than 10,000 lines. Choose a shorter date range.");
  }

  const header = [
    "Order reference", "Placed at (UTC)", "Order status", "GriipBuddy delivery", "Shop preparation",
    "Product", "Variant", "SKU", "Quantity", "Merchandise subtotal (minor units)", "Currency",
  ];
  return [
    header,
    ...items.map(({ order, productName, variantName, sku, quantity, lineTotalMinor, currency }) => [
      order.reference,
      order.createdAt.toISOString(),
      order.status === "CANCELLED" ? "Cancelled" : "Placed",
      order.status === "CANCELLED" ? "" : fulfillmentLabels[order.fulfillmentStatus],
      order.sellerFulfillments[0] ? sellerPreparationLabels[order.sellerFulfillments[0].status] : "Awaiting preparation",
      productName, variantName, sku, quantity, lineTotalMinor, currency,
    ]),
  ].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function staffSellerPreparation(orderId: string, shopIds: string[]) {
  return getDb().marketplaceShop.findMany({
    where: { id: { in: shopIds } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      fulfillments: { where: { orderId }, select: { status: true, updatedAt: true } },
    },
  });
}
