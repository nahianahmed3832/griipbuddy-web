import type { Prisma } from "../../generated/prisma/client.ts";
import type { ParcelTrackingStatus } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";
import { bangladeshTrackingHistory } from "./bangladesh-shipment.ts";
import { currentParcelTrackingStatus, normalizedParcelEventStatus, normalizedParcelTrackingStatus } from "./parcel-tracking.ts";

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

function parcelSelection(after: string | null) {
  return {
    where: after ? { id: { gt: after } } : undefined, orderBy: { id: "asc" }, take: shipmentLimit + 1,
    select: {
      id: true, status: true, trackingStatus: true, carrier: true, trackingReference: true, source: true,
      statusUpdatedAt: true, trackingOccurredAt: true, estimatedDeliveryAt: true, trackingSyncedAt: true,
      items: { orderBy: { orderItemId: "asc" }, take: itemLimit + 1,
        select: { quantity: true, orderItem: { select: itemFields } } },
      events: { orderBy: [{ recordedAt: "desc" }, { status: "desc" }], take: eventLimit + 1,
        select: { status: true, recordedAt: true } },
      trackingObservations: { where: { applied: true, status: { not: null } },
        orderBy: [{ occurredAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }], take: eventLimit + 1,
        select: { status: true, source: true, occurredAt: true, recordedAt: true } },
    },
  } satisfies Prisma.Order$parcelsArgs;
}

export async function readOrderTracking(id: string, viewer: OrderTrackingViewer, after: string | null) {
  const db = getDb();
  const owner = "shopperId" in viewer ? { shopperId: viewer.shopperId } : { shopperId: null, attempt: { guestKey: viewer.guestKey } };
  const row = await db.order.findFirst({ where: { id, ...owner }, select: {
    id: true, reference: true, marketId: true, status: true, parcels: parcelSelection(after),
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
    items: parcel.items.slice(0, itemLimit).map(({ orderItem: { id, ...item }, quantity }) => ({ orderItemId: id, ...item, quantity })),
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
  const historicalOrderHandoff = row.carrier && row.trackingReference && (row.fulfillmentStatus === "SHIPPED" || row.fulfillmentStatus === "DELIVERED");
  if (after || shipments.length || (!shipment && !historicalOrderHandoff)) {
    return { ...basic, shipments, nextCursor: row.parcels.length > shipmentLimit ? shipments.at(-1)!.id : null };
  }

  const items = await db.orderItem.findMany({ where: { orderId: row.id }, orderBy: { id: "asc" }, take: itemLimit + 1,
    select: { ...itemFields, quantity: true } });
  const publicItems = items.slice(0, itemLimit).map(({ id, ...item }) => ({ orderItemId: id, ...item }));
  if (!shipment) {
    const events = await db.fulfillmentEvent.findMany({ where: { orderId: row.id, status: { in: ["SHIPPED", "DELIVERED"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: eventLimit + 1, select: { status: true, createdAt: true } });
    return { ...basic, shipments: [{ id: row.id, recordType: "LEGACY_ORDER" as const,
      status: row.fulfillmentStatus === "DELIVERED" ? "DELIVERED" as const : "HANDED_TO_CARRIER" as const,
      ...carrierLookup(row.carrier, row.trackingReference), statusUpdatedAt: events[0]?.createdAt ?? null,
      estimatedDeliveryAt: null, lastSyncedAt: null, items: publicItems, itemsTruncated: items.length > itemLimit,
      ...publicHistory(events.map(({ status, createdAt }) => ({ status: status === "DELIVERED" ? "DELIVERED" : "HANDED_TO_CARRIER",
        occurredAt: createdAt, receivedAt: createdAt, source: "LEGACY" }))),
    }], nextCursor: null };
  }
  const returned = row.bangladeshRefusedParcelReceipt?.receivedAt;
  return { ...basic, shipments: [{
    id: row.id, recordType: "LEGACY_BD" as const,
    status: returned ? "RETURNED" as const : normalizedParcelTrackingStatus(shipment.status),
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
