import type { Prisma } from "../../generated/prisma/client.ts";
import type { ParcelTrackingStatus } from "../../generated/prisma/enums.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { bangladeshTrackingHistory } from "./bangladesh-shipment.ts";
import { integratedCheckout, readRecoveredOrder } from "./integrated-checkout.ts";
import { currentParcelTrackingStatus, normalizedParcelEventStatus, normalizedParcelTrackingStatus, shipmentSummary } from "./parcel-tracking.ts";

export type OrderTrackingViewer = { shopperId: string } | { guestKey: string };

const shipmentLimit = 20;
const eventLimit = 25;
const itemLimit = 50;
const itemFields = { id: true, productName: true, variantName: true, sku: true } as const;

function carrierLookup(carrier: string | null, reference: string | null) {
  const trackingReference = reference?.trim();
  const safeReference = trackingReference && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(trackingReference) ? trackingReference : null;
  const name = carrier?.trim() || null;
  // The public form accepts a pasted tracking code. Keep the code out of external URLs.
  const approved = name && ["steadfast", "steadfast courier"].includes(name.toLowerCase());
  return { carrier: name, trackingReference: safeReference,
    trackingUrl: approved && safeReference ? "https://www.steadfast.com.bd/tracking" : null };
}

type PublicEvent = {
  status: ParcelTrackingStatus;
  occurredAt: Date | null;
  receivedAt: Date;
  source: "SYSTEM" | "MANUAL" | "DEV_SIMULATOR" | "LEGACY" | "CARRIER_WEBHOOK";
};

function publicHistory(events: PublicEvent[]) {
  events.sort((left, right) => +(left.occurredAt ?? left.receivedAt) - +(right.occurredAt ?? right.receivedAt) ||
    +left.receivedAt - +right.receivedAt);
  return { events: events.slice(-eventLimit), eventsTruncated: events.length > eventLimit };
}

function parcelSelection(db: DbReader, after: string | null, account: boolean) {
  return {
    where: { cancelledAt: null, ...(after && { id: { gt: after } }) }, orderBy: { id: "asc" }, take: shipmentLimit + 1,
    select: {
      id: true, status: true, trackingStatus: true, carrier: true, trackingReference: true, source: true,
      statusUpdatedAt: true, trackingOccurredAt: true, estimatedDeliveryAt: true, trackingSyncedAt: true,
      items: { where: { quantity: { gt: db.orderParcelItem.fields.cancelledQuantity } }, orderBy: { orderItemId: "asc" }, take: account ? itemLimit + 1 : 0,
        select: { quantity: true, cancelledQuantity: true, orderItem: { select: itemFields } } },
      events: { orderBy: [{ recordedAt: "desc" }, { status: "desc" }], take: eventLimit + 1,
        select: { status: true, recordedAt: true } },
      trackingObservations: { where: { applied: true, status: { not: null } },
        orderBy: [{ occurredAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }], take: eventLimit + 1,
        select: { status: true, source: true, occurredAt: true, recordedAt: true } },
    },
  } satisfies Prisma.Order$parcelsArgs;
}

async function readRecoveredTracking(id: string, viewer: OrderTrackingViewer, after: string | null) {
  if (after || !integratedCheckout("bd")) return null;
  const account = "shopperId" in viewer;
  const recovered = await readRecoveredOrder(id, account ? null : viewer.guestKey, account ? viewer.shopperId : null);
  if (!recovered) return null;
  const status = recovered.fulfillment === "DELIVERED" ? "DELIVERED"
    : recovered.fulfillment === "SHIPPED" ? "HANDED_TO_CARRIER" : "PREPARING";
  const shipments = status === "PREPARING" ? [] : [{ id, recordType: "RECOVERED_ORDER" as const, status,
    ...carrierLookup(null, recovered.tracking ?? null), statusUpdatedAt: null, estimatedDeliveryAt: null, lastSyncedAt: null,
    items: account ? recovered.original.lines.slice(0, itemLimit).map((line, index) => ({ orderItemId: `${id}-${index}`,
      productName: line.title, variantName: Object.values(line.attributes ?? {}).join(" / "), sku: line.sku, quantity: line.quantity })) : [],
    itemsTruncated: account && recovered.original.lines.length > itemLimit,
    ...publicHistory([]),
  }];
  return { orderId: id, reference: recovered.number, marketId: "bd" as const,
    orderStatus: recovered.status === "cancelled" ? "CANCELLED" as const : "PLACED" as const,
    summary: shipmentSummary(status === "PREPARING" ? [] : [{ status, count: 1 }]), shipments, nextCursor: null };
}

async function readNativeOrderTracking(db: DbReader, id: string, viewer: OrderTrackingViewer, after: string | null) {
  const account = "shopperId" in viewer;
  const owner = account ? { shopperId: viewer.shopperId } : { shopperId: null, attempt: { guestKey: viewer.guestKey } };
  const row = await db.order.findFirst({ where: { id, ...owner }, select: {
    id: true, reference: true, marketId: true, status: true, parcels: parcelSelection(db, after, account),
    carrier: true, trackingReference: true, fulfillmentStatus: true,
    bangladeshShipment: bangladeshTrackingHistory,
    bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
  } });
  if (!row) return null;
  const shipments = row.parcels.slice(0, shipmentLimit).map(parcel => ({
    id: parcel.id, recordType: "PARCEL" as const, status: currentParcelTrackingStatus(parcel),
    ...carrierLookup(parcel.carrier, parcel.trackingReference),
    statusUpdatedAt: parcel.trackingOccurredAt ?? parcel.statusUpdatedAt,
    estimatedDeliveryAt: parcel.estimatedDeliveryAt, lastSyncedAt: parcel.trackingSyncedAt,
    items: parcel.items.slice(0, itemLimit).map(({ orderItem: { id, ...item }, quantity, cancelledQuantity }) =>
      ({ orderItemId: id, ...item, quantity: quantity - cancelledQuantity })),
    itemsTruncated: parcel.items.length > itemLimit,
    ...publicHistory([
      ...parcel.events.map((event): PublicEvent => ({
        status: normalizedParcelEventStatus(event.status), occurredAt: event.recordedAt, receivedAt: event.recordedAt,
        source: event.status === "PLANNED" ? "SYSTEM" : parcel.source ?? "LEGACY",
      })),
      ...parcel.trackingObservations.flatMap(({ status, occurredAt, recordedAt, source }): PublicEvent[] => status ? [
        { status, occurredAt, receivedAt: recordedAt, source },
      ] : []),
    ]),
  }));
  const basic = { orderId: row.id, reference: row.reference, marketId: row.marketId, orderStatus: row.status };
  const shipment = row.bangladeshShipment;
  const historicalOrderHandoff = row.fulfillmentStatus === "SHIPPED" || row.fulfillmentStatus === "DELIVERED";
  if (after || shipments.length || (!shipment && !historicalOrderHandoff)) {
    const groups = await db.orderParcel.groupBy({ by: ["status", "trackingStatus"], where: { orderId: row.id, cancelledAt: null }, _count: { _all: true } });
    const summary = shipmentSummary(groups.map(group => ({ status: currentParcelTrackingStatus(group), count: group._count._all })));
    return { ...basic, summary, shipments, nextCursor: row.parcels.length > shipmentLimit ? shipments.at(-1)!.id : null };
  }

  const items = account ? await db.orderItem.findMany({ where: { orderId: row.id }, orderBy: { id: "asc" }, take: itemLimit + 1,
    select: { ...itemFields, quantity: true } }) : [];
  const publicItems = items.slice(0, itemLimit).map(({ id, ...item }) => ({ orderItemId: id, ...item }));
  if (!shipment) {
    const events = await db.fulfillmentEvent.findMany({ where: { orderId: row.id, status: { in: ["SHIPPED", "DELIVERED"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: eventLimit + 1, select: { status: true, createdAt: true } });
    const status = row.fulfillmentStatus === "DELIVERED" ? "DELIVERED" : "HANDED_TO_CARRIER";
    return { ...basic, summary: shipmentSummary([{ status, count: 1 }]), shipments: [{ id: row.id, recordType: "LEGACY_ORDER" as const, status,
      ...carrierLookup(row.carrier, row.trackingReference), statusUpdatedAt: events[0]?.createdAt ?? null,
      estimatedDeliveryAt: null, lastSyncedAt: null, items: publicItems, itemsTruncated: items.length > itemLimit,
      ...publicHistory(events.map(({ status, createdAt }) => ({ status: status === "DELIVERED" ? "DELIVERED" : "HANDED_TO_CARRIER",
        occurredAt: createdAt, receivedAt: createdAt, source: "LEGACY" }))),
    }], nextCursor: null };
  }
  const returned = row.bangladeshRefusedParcelReceipt?.receivedAt;
  const status = returned ? "RETURNED" : normalizedParcelTrackingStatus(shipment.status);
  return { ...basic, summary: shipmentSummary([{ status, count: 1 }]), shipments: [{
    id: row.id, recordType: "LEGACY_BD" as const, status,
    ...carrierLookup(shipment.carrier, shipment.trackingReference),
    statusUpdatedAt: returned ?? shipment.statusUpdatedAt, estimatedDeliveryAt: null, lastSyncedAt: null,
    items: publicItems, itemsTruncated: items.length > itemLimit,
    ...publicHistory([
      ...shipment.events.map(({ status, recordedAt }): PublicEvent => ({
        status: normalizedParcelTrackingStatus(status), occurredAt: recordedAt, receivedAt: recordedAt, source: shipment.source,
      })),
      ...(returned ? [{ status: "RETURNED" as const, occurredAt: returned, receivedAt: returned, source: "LEGACY" as const }] : []),
    ]),
  }], nextCursor: null };
}

export async function readOrderTracking(id: string, viewer: OrderTrackingViewer, after: string | null) {
  const native = await getDb().$transaction(tx => readNativeOrderTracking(tx, id, viewer, after), { isolationLevel: "RepeatableRead" });
  return native ?? readRecoveredTracking(id, viewer, after);
}
