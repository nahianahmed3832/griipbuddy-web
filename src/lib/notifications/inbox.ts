import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { fulfillmentLabels } from "../commerce/labels.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { lockSellerScope, resolveSellerAccess } from "../marketplace/seller-access.ts";
import { staffMarketIds } from "../staff/market-access.ts";
import { authorizeOrderOperation } from "../staff/operations.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";

export type InboxAudience = "customer" | "seller" | "staff";
export type InboxViewer = { audience: InboxAudience; actorId: string; marketId: MarketId; shopId?: string };
type InboxEvent = { key: string; title: string; reference: string; occurredAt: Date; href: string };

export class NotificationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function authorizeNotifications(db: DbReader, actorId: string, marketId: MarketId, ownerOnly = false) {
  try { await authorizeOrderOperation(db, actorId, marketId, ownerOnly); }
  catch (error) {
    if (error instanceof CatalogWriteError) {
      throw new NotificationError(ownerOnly ? "Owner access is required." : "This inbox is unavailable.", ownerOnly ? 403 : 404);
    }
    throw error;
  }
}

const inboxSize = 60;
const orderSelect = { id: true, reference: true, createdAt: true } as const;

async function scopeInbox(db: DbReader, viewer: InboxViewer, write = false) {
  if (!isMarketSelectable(viewer.marketId)) throw new NotificationError("This inbox is unavailable.", 404);
  const where: Prisma.OrderWhereInput = { marketId: viewer.marketId };
  let shopScope = "";
  const { actorId, marketId, audience } = viewer;
  if (audience === "staff") {
    if (write) await authorizeNotifications(db, actorId, marketId);
    else if (!(await staffMarketIds(actorId, "operations", db)).includes(marketId)) {
      throw new NotificationError("This inbox is unavailable.", 404);
    }
  } else if (audience === "customer") {
    where.shopperId = actorId;
  } else {
    const seller = await resolveSellerAccess(actorId, marketId, "ORDER_PREPARATION", viewer.shopId, db);
    if (!seller) throw new NotificationError("This inbox is unavailable.", 404);
    if (write) {
      await lockSellerScope(db, seller.shop.id, marketId);
      if (!await resolveSellerAccess(actorId, marketId, "ORDER_PREPARATION", seller.shop.id, db)) {
        throw new NotificationError("This inbox is unavailable.", 404);
      }
    }
    shopScope = seller.shop.id;
    where.items = { some: { marketplaceShopId: shopScope } };
  }
  return { where, receipt: { audience, actorId, shopScope, marketId } };
}

function orderDestination(viewer: InboxViewer, orderId: string) {
  const prefix = viewer.audience === "staff" ? "/staff" : viewer.audience === "seller" ? "/seller" : "";
  const params = new URLSearchParams({ market: viewer.marketId, ...(viewer.audience === "seller" && viewer.shopId && { shop: viewer.shopId }) });
  return `${prefix}/orders/${orderId}?${params}`;
}

async function orderEvents(db: DbReader, viewer: InboxViewer, where: Prisma.OrderWhereInput, key?: string) {
  const policy = await db.notificationOrderPolicy.findUnique({ where: { marketId: viewer.marketId } });
  const [kind, recordId] = key?.split(":") ?? [];
  const result = await Promise.all([
    policy?.placed !== false && (!key || kind === "order") ? db.order.findMany({
      where: { ...where, ...(recordId && { id: recordId }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: key ? 1 : inboxSize, select: orderSelect,
    }) : [],
    // An order-wide shipment update could disclose activity for a different seller's parcel.
    viewer.audience !== "seller" && policy?.fulfillment !== false && (!key || kind === "fulfillment") ?
      db.fulfillmentEvent.findMany({
        where: { order: where, type: { not: "ORDER_PLACED" }, ...(recordId && { id: recordId }) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: key ? 1 : inboxSize,
        select: { id: true, type: true, status: true, createdAt: true, order: { select: orderSelect } },
      }) : [],
  ]);
  const [orders, updates] = result;
  const events: InboxEvent[] = [
    ...orders.map(order => ({ key: `order:${order.id}`, title: "Order placed", reference: order.reference,
      occurredAt: order.createdAt, href: orderDestination(viewer, order.id) })),
    ...updates.map(event => ({ key: `fulfillment:${event.id}`,
      title: event.type === "ORDER_CANCELLED" ? "Order cancelled" : fulfillmentLabels[event.status],
      reference: event.order.reference, occurredAt: event.createdAt, href: orderDestination(viewer, event.order.id) })),
  ];
  return events.sort((left, right) =>
    right.occurredAt.valueOf() - left.occurredAt.valueOf() || right.key.localeCompare(left.key));
}

export async function notificationInbox(viewer: InboxViewer) {
  return getDb().$transaction(async db => {
    const { where, receipt } = await scopeInbox(db, viewer);
    const events = await orderEvents(db, { ...viewer, shopId: receipt.shopScope || undefined }, where);
    const receipts = await db.notificationInboxReceipt.findMany({
      where: { ...receipt, eventKey: { in: events.map(event => event.key) } },
      select: { eventKey: true, readAt: true, dismissedAt: true },
    });
    const readState = new Map(receipts.map(row => [row.eventKey, row]));
    return events.filter(event => !readState.get(event.key)?.dismissedAt).slice(0, inboxSize)
      .map(event => ({ ...event, read: readState.has(event.key) }));
  }, { isolationLevel: "RepeatableRead" });
}

export async function markNotification(viewer: InboxViewer, eventKey: string, dismiss: boolean, at = new Date()) {
  if (!/^(?:order|fulfillment):[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(eventKey)) {
    throw new NotificationError("This notification is unavailable.", 404);
  }
  return getDb().$transaction(async db => {
    const { where, receipt } = await scopeInbox(db, viewer, true);
    if (!(await orderEvents(db, viewer, where, eventKey)).some(item => item.key === eventKey)) {
      throw new NotificationError("This notification is unavailable.", 404);
    }
    const key = { ...receipt, eventKey };
    await db.notificationInboxReceipt.createMany({ data: { ...key, readAt: at, dismissedAt: dismiss ? at : null }, skipDuplicates: true });
    if (dismiss) await db.notificationInboxReceipt.updateMany({ where: { ...key, dismissedAt: null }, data: { dismissedAt: at } });
  });
}

export async function setOrderNotifications(actorId: string, marketId: MarketId, options: { placed: boolean; fulfillment: boolean }) {
  return getDb().$transaction(async db => {
    if (!isMarketSelectable(marketId)) throw new NotificationError("This market is unavailable.", 404);
    await authorizeNotifications(db, actorId, marketId, true);
    await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`notifications:${marketId}`}), 1111)`;
    const previous = await db.notificationOrderPolicy.findUnique({ where: { marketId } });
    if ((previous?.placed ?? true) === options.placed && (previous?.fulfillment ?? true) === options.fulfillment) return;
    await db.notificationOrderPolicy.upsert({
      where: { marketId }, create: { marketId, ...options, updatedBy: actorId },
      update: { ...options, updatedBy: actorId },
    });
    await db.auditEvent.create({ data: { actorId, action: "NOTIFICATION_POLICY_CHANGED", target: `notifications:${marketId}`,
      changes: { marketId, ...options } } });
  });
}
