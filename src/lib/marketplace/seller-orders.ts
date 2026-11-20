import { Prisma } from "../../generated/prisma/client.ts";
import type { FulfillmentStatus, OrderStatus } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";
import type { SellerOrderRange } from "./seller-order-range.ts";
import { nextSellerPreparation, sellerPaymentAllowsPreparation, sellerPreparationInput, sellerPreparationLabels } from "./seller-preparation.ts";
import { fulfillmentLabels } from "../commerce/labels.ts";
import { parcelItemsToShip } from "../commerce/parcel-tracking.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { markets, type Currency, type MarketId } from "../../config/markets.ts";
import type { SellerActor, ShopperActor } from "../access/actors.ts";
import { getSellerAccess, lockSellerScope, resolveSellerAccess } from "./seller-access.ts";

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

export async function sellerOrderWorkspace(shopperId: string, marketId: MarketId, selectedShop?: string) {
  const access = await resolveSellerAccess(shopperId, marketId, "ORDER_PREPARATION", selectedShop);
  if (access) return { ...access.shop, managed: true, canPrepare: true, finance: access.owner || access.permissions.includes("FINANCE_VIEW"),
    owner: access.owner };
  const legacy = selectedShop ? null : await sellerShop(shopperId);
  if (!legacy) return null;
  const historicalGrant = await getDb().marketplaceShopMarket.findUnique({
    where: { shopId_marketId: { shopId: legacy.id, marketId } }, select: { status: true },
  });
  return { ...legacy, managed: false, canPrepare: !historicalGrant, finance: true, owner: true };
}

export async function sellerOwner(shopper: ShopperActor): Promise<SellerActor | null> {
  const shop = await sellerShop(shopper.id);
  return shop ? { kind: "seller-owner", id: shopper.id, shopId: shop.id } : null;
}

function sellerOrderSelect(shopId: string, items: Prisma.OrderItemWhereInput) {
  const ownParcelItems = { orderItem: items, quantity: { gt: getDb().orderParcelItem.fields.cancelledQuantity } };
  return {
    id: true,
    reference: true,
    createdAt: true,
    status: true,
    fulfillmentStatus: true,
    marketId: true,
    payment: { select: { method: true, status: true, currency: true } },
    items: {
      where: items,
      orderBy: { id: "asc" },
      select: {
        id: true, productName: true, variantName: true, sku: true, quantity: true,
        lineTotalMinor: true, deliveryAllocatedMinor: true, taxAllocatedMinor: true, personalization: true,
      },
    },
    parcels: {
      where: { cancelledAt: null, items: { some: ownParcelItems } },
      orderBy: [{ locationName: "asc" }, { id: "asc" }],
      select: {
        id: true, status: true, locationName: true, carrier: true, trackingReference: true,
        items: { where: ownParcelItems, orderBy: { orderItemId: "asc" }, select: {
          quantity: true, cancelledQuantity: true, orderItem: { select: { id: true, productName: true, variantName: true } },
        } },
      },
    },
    sellerFulfillments: { where: { shopId }, select: { status: true, updatedAt: true } },
  } satisfies Prisma.OrderSelect;
}

function sellerParcelQuantities(order: Prisma.OrderGetPayload<{ select: ReturnType<typeof sellerOrderSelect> }>) {
  return { ...order, parcels: order.parcels.map(parcel => ({ ...parcel,
    items: parcelItemsToShip(parcel.items).map(({ quantity, orderItem }) => ({ quantity, orderItem })),
  })) };
}

export function sellerOrderDetail(shopId: string, orderId: string, marketId: MarketId) {
  if (!uuid.safeParse(orderId).success) return null;
  const { currency } = markets[marketId];
  const items = { ...sellerItemScope(shopId), currency };
  return getDb().order.findFirst({
    where: { id: orderId, marketId, currency, items: { some: items } },
    select: sellerOrderSelect(shopId, items),
  }).then(order => order && sellerParcelQuantities(order));
}

export async function sellerOrderPage(shopId: string, range: SellerOrderRange, page: number) {
  const db = getDb();
  const { currency } = markets[range.marketId];
  const items = { ...sellerItemScope(shopId), currency };
  const date = { gte: range.start, lt: range.endExclusive };
  const orderScope = { marketId: range.marketId, currency, createdAt: date, items: { some: items } };
  const [orders, placed, totals] = await Promise.all([
    db.order.findMany({
      where: orderScope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
      select: sellerOrderSelect(shopId, items),
    }),
    db.order.count({ where: { ...orderScope, status: "PLACED" } }),
    db.orderItem.groupBy({
      by: ["currency"],
      where: { ...items, order: { marketId: range.marketId, currency, createdAt: date, status: "PLACED" } },
      _sum: { quantity: true, lineTotalMinor: true },
      orderBy: { currency: "asc" },
    }),
  ]);

  return {
    orders: orders.slice(0, pageSize).map(sellerParcelQuantities),
    hasNext: orders.length > pageSize,
    placed,
    units: totals.reduce((sum, row) => sum + (row._sum.quantity ?? 0), 0),
    merchandise: totals.map(row => ({ currency: row.currency, amountMinor: row._sum.lineTotalMinor ?? 0 })),
  };
}

export async function advanceSellerPreparation(shopperId: string, input: unknown) {
  const parsed = sellerPreparationInput.safeParse(input);
  if (!parsed.success) throw new SellerOrderError(400, "Choose a valid preparation step.");
  const { orderId, next, marketId, shopId } = parsed.data;
  if (shopId && !marketId) throw new SellerOrderError(404, "Order not found.");

  return getDb().$transaction(async tx => {
    // The scoped delegate path serializes membership and market revocation before the shared order change.
    if (shopId && marketId) {
      await lockSellerScope(tx, shopId, marketId);
      if (!await getSellerAccess(shopperId, shopId, marketId, "ORDER_PREPARATION", tx)) {
        throw new SellerOrderError(404, "Order not found.");
      }
    }
    const shop = shopId ? { id: shopId } : await tx.marketplaceShop.findUnique({ where: { ownerId: shopperId }, select: { id: true } });
    if (!shop) throw new SellerOrderError(404, "Order not found.");
    if (!shopId) await tx.$queryRaw`SELECT id FROM "MarketplaceShop" WHERE id = ${shop.id}::uuid FOR SHARE`;

    // Use the same Order row lock as staff fulfillment and cancellation.
    const [order] = await tx.$queryRaw<{
      shopId: string; status: OrderStatus; fulfillmentStatus: FulfillmentStatus; marketId: MarketId; currency: Currency;
    }[]>`
      SELECT s."id" AS "shopId", o."status", o."fulfillmentStatus", o."marketId", o."currency"
      FROM "Order" o
      JOIN "MarketplaceShop" s ON s."id" = ${shop.id}::uuid
      WHERE o."id" = ${orderId}::uuid
        AND EXISTS (
          SELECT 1 FROM "OrderItem" i
          WHERE i."orderId" = o."id" AND i."marketplaceShopId" = s."id" AND i."currency" = o."currency"
        )
      FOR UPDATE OF o
    `;
    if (!order || marketId !== undefined && marketId !== order.marketId || markets[order.marketId]?.currency !== order.currency) {
      throw new SellerOrderError(404, "Order not found.");
    }
    if (!shopId) {
      const grant = await tx.marketplaceShopMarket.findUnique({
        where: { shopId_marketId: { shopId: shop.id, marketId: order.marketId } }, select: { status: true },
      });
      if (grant && !await getSellerAccess(shopperId, shop.id, order.marketId, "ORDER_PREPARATION", tx)) {
        throw new SellerOrderError(404, "Order not found.");
      }
    }
    const payment = await tx.payment.findUnique({ where: { orderId }, select: { method: true, status: true, currency: true } });
    if (payment?.currency !== order.currency || !sellerPaymentAllowsPreparation(payment)) {
      throw new SellerOrderError(409, "This order is not ready for preparation.");
    }
    const key = { orderId, shopId: order.shopId };
    const where = { orderId_shopId: key };
    const previous = await tx.marketplaceSellerFulfillment.findUnique({ where, select: { status: true } });
    if (previous?.status === next) return { status: next };
    const ownParcelPending = order.fulfillmentStatus === "SHIPPED" && Boolean(await tx.orderParcel.findFirst({
      where: { orderId, cancelledAt: null, status: "PLANNED", items: { some: {
        orderItem: sellerItemScope(order.shopId), quantity: { gt: tx.orderParcelItem.fields.cancelledQuantity },
      } } }, select: { id: true },
    }));
    if (nextSellerPreparation(order.status, order.fulfillmentStatus, previous?.status ?? null, ownParcelPending) !== next) {
      throw new SellerOrderError(409, "That step is no longer available. Refresh the order and try again.");
    }
    const result = await tx.marketplaceSellerFulfillment.upsert({
      where,
      create: { ...key, status: next },
      update: { status: next },
      select: { status: true },
    });
    await tx.auditEvent.create({ data: { action: "FULFILLMENT_CHANGED", target: orderId, changes: {
      type: "SELLER_PREPARATION", actor: { kind: "seller", id: shopperId }, marketId: order.marketId, shopId: order.shopId,
      operationId: `${orderId}:${order.shopId}:${next}`, from: previous?.status ?? null, to: next,
      reason: "Confirmed seller preparation step",
    } } });
    return result;
  });
}

// Spreadsheet applications can evaluate a quoted CSV cell as a formula.
function csvCell(value: string | number) {
  const text = String(value);
  const safe = typeof value === "string" && (/^\s*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function sellerOrdersCsv(shopId: string, range: SellerOrderRange) {
  const { currency } = markets[range.marketId];
  const items = await getDb().orderItem.findMany({
    where: { ...sellerItemScope(shopId), currency,
      order: { marketId: range.marketId, currency, createdAt: { gte: range.start, lt: range.endExclusive } } },
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
