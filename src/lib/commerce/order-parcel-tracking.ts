import type { MarketId } from "../../config/markets.ts";
import type { OrderParcelStatus } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";
import { consumeQuota } from "../db/observability.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";
import { operationsScope } from "../staff/operations.ts";
import { carrierTrackingRelayEnabled, parcelTrackingRelayProvider, supportsParcelTrackingRelayReference, type CarrierTrackingObservation } from "./carrier-tracking-relay.ts";
import { canAdvanceParcelTracking, currentParcelTrackingStatus } from "./parcel-tracking.ts";

const refreshWindowSeconds = 30;

export function parcelTrackingRelayReadiness(parcel: { carrier: string | null; trackingReference: string | null }, testOrder: boolean, marketId: MarketId) {
  if (!testOrder || !carrierTrackingRelayEnabled()) return { canRefresh: false, refreshReason: "Carrier tracking is unconfigured for this order." };
  if (marketId !== "bd" || !supportsParcelTrackingRelayReference(parcel.trackingReference) || !parcelTrackingRelayProvider(parcel.carrier)) {
    return { canRefresh: false, refreshReason: "This carrier or reference has no verified tracking relay." };
  }
  return { canRefresh: true, refreshReason: "Checks recorded relay updates. This action makes no carrier request." };
}

export async function refreshOrderParcelTracking(actorId: string, orderId: string, parcelId: string) {
  const db = getDb();
  const scope = await operationsScope(db, actorId);
  const parcel = await db.orderParcel.findFirst({ where: { id: parcelId, orderId, order: scope },
    select: { carrier: true, trackingReference: true, trackingSyncedAt: true, order: { select: { measurementTest: true, marketId: true } } } });
  if (!parcel) throw new CatalogWriteError("not_found", "This parcel is unavailable for this order.");
  const readiness = parcelTrackingRelayReadiness(parcel, parcel.order.measurementTest === true, parcel.order.marketId);
  if (!readiness.canRefresh) throw new CatalogWriteError("conflict", readiness.refreshReason);
  if (!await consumeQuota("order.tracking.refresh", `${actorId}:${parcelId}`, 1, refreshWindowSeconds)) {
    throw new CatalogWriteError("rate_limited", "Try checking this parcel again in 30 seconds.");
  }
  return { parcelId, checkedAt: new Date(), lastSyncedAt: parcel.trackingSyncedAt };
}

function shopFulfilmentState(current: OrderParcelStatus, incoming: CarrierTrackingObservation) {
  if ("error" in incoming || (current !== "IN_TRANSIT" && current !== "OUT_FOR_DELIVERY")) return null;
  if (incoming.status === "DELIVERED") return "DELIVERED" as const;
  if (incoming.status === "OUT_FOR_DELIVERY" && current === "IN_TRANSIT") return "OUT_FOR_DELIVERY" as const;
  return null;
}

export async function recordCarrierParcelObservation(input: CarrierTrackingObservation) {
  if (!carrierTrackingRelayEnabled()) throw new CatalogWriteError("not_found", "The tracking relay is unavailable.");
  const { parcelId, carrier, trackingReference, occurredAt, eventId } = input;
  const status = "status" in input ? input.status : null;
  const providerCode = "providerCode" in input ? input.providerCode : null;
  const error = "error" in input ? input.error : null;
  const estimatedDeliveryAt = "estimatedDeliveryAt" in input ? input.estimatedDeliveryAt ?? null : null;
  const eventKey = `${carrier}:${eventId}`;

  return getDb().$transaction(async tx => {
    const known = await tx.orderParcel.findUnique({ where: { id: parcelId }, select: { orderId: true } });
    if (!known) throw new CatalogWriteError("not_found", "The parcel is unavailable to this relay.");
    // Existing fulfilment writers hold the same order lock. This path never acquires an inventory or payment lock.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${known.orderId}::uuid FOR UPDATE`;
    const parcel = await tx.orderParcel.findUnique({ where: { id: parcelId }, include: { order: {
      select: { id: true, status: true, fulfillmentStatus: true, measurementTest: true, marketId: true },
    } } });
    if (!parcel || parcel.order.marketId !== "bd" || parcel.order.measurementTest !== true || parcelTrackingRelayProvider(parcel.carrier) !== carrier ||
        parcel.trackingReference?.toLowerCase() !== trackingReference.toLowerCase()) {
      throw new CatalogWriteError("not_found", "The parcel is unavailable to this relay.");
    }
    const previous = await tx.parcelTrackingObservation.findUnique({ where: { parcelId_eventKey: { parcelId, eventKey } } });
    if (previous) {
      if (previous.status !== status || previous.error !== error || previous.providerCode !== providerCode ||
          +previous.occurredAt !== +occurredAt || previous.estimatedDeliveryAt?.getTime() !== estimatedDeliveryAt?.getTime()) {
        throw new CatalogWriteError("conflict", "The relay event ID already identifies a different observation.");
      }
      return { duplicate: true, applied: previous.applied };
    }

    const recordedAt = new Date();
    const applied = parcel.order.status === "PLACED" && status !== null &&
      (parcel.status !== "PLANNED" || status === "PREPARING") &&
      occurredAt > (parcel.trackingOccurredAt ?? parcel.statusUpdatedAt) &&
      canAdvanceParcelTracking(currentParcelTrackingStatus(parcel), status);
    const latestReport = !parcel.trackingReportedAt || occurredAt > parcel.trackingReportedAt;
    const operational = applied ? shopFulfilmentState(parcel.status, input) : null;
    await tx.parcelTrackingObservation.create({ data: {
      parcelId, source: "CARRIER_WEBHOOK", eventKey, status, providerCode, occurredAt, recordedAt, estimatedDeliveryAt, error, applied,
    } });
    await tx.orderParcel.update({ where: { id: parcelId }, data: {
      trackingAttemptAt: recordedAt, ...(error ? {} : { trackingSyncedAt: recordedAt }),
      ...(latestReport && { trackingReportedAt: occurredAt, trackingSyncError: error }),
      ...(applied && { trackingStatus: status, trackingOccurredAt: occurredAt, trackingRevision: { increment: 1 },
        ...(status === "DELIVERED" || status === "RETURNED" ? { estimatedDeliveryAt: null } : estimatedDeliveryAt ? { estimatedDeliveryAt } : {}) }),
      ...(operational && { status: operational, statusUpdatedAt: occurredAt }),
    } });
    if (operational === "DELIVERED" && parcel.order.fulfillmentStatus === "SHIPPED" &&
        !await tx.orderParcel.findFirst({ where: { orderId: parcel.orderId, status: { not: "DELIVERED" } }, select: { id: true } })) {
      await tx.order.update({ where: { id: parcel.orderId }, data: { fulfillmentStatus: "DELIVERED" } });
      await tx.fulfillmentEvent.create({ data: { orderId: parcel.orderId, status: "DELIVERED", type: "STATUS_CHANGED" } });
    }
    return { duplicate: false, applied };
  });
}
