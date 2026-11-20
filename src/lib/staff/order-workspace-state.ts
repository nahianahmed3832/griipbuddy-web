import { canCancelFrom, fulfillmentLabels, nextFulfillment } from "../commerce/labels.ts";
import { currentParcelTrackingStatus, parcelOrderLabel, parcelWasRefused } from "../commerce/parcel-tracking.ts";
import type { listStaffOrders, staffOrder } from "./operations.ts";

type Order = NonNullable<Awaited<ReturnType<typeof staffOrder>>>;
type QueueRow = Awaited<ReturnType<typeof listStaffOrders>>["rows"][number];

export function staffQueueStatus(order: QueueRow) {
  const exception = order.parcels.some(parcel => currentParcelTrackingStatus(parcel) === "DELIVERY_EXCEPTION");
  const fulfillment = order.status === "CANCELLED" ? "Cancelled"
    : exception ? "Delivery issue"
    : order.parcels.some(parcel => parcel.status !== "PLANNED") ? parcelOrderLabel(order.parcels)
    : order.bangladeshRefusedParcelReceipt ? "Refused · received at warehouse"
    : order.bangladeshShipment?.status === "REFUSED" ? "Refused · awaiting warehouse return"
    : order.bangladeshShipment?.status === "OUT_FOR_DELIVERY" ? "Out for delivery"
    : fulfillmentLabels[order.fulfillmentStatus];
  return { fulfillment, requiresCodReview: order.payment?.status === "AWAITING_COLLECTION" && order.parcels.some(parcelWasRefused),
    pendingCancellation: order.cases.length > 0 };
}

export function staffOrderWorkspaceState(order: Order, payment: NonNullable<Order["payment"]>) {
  const active = order.status === "PLACED";
  const cod = payment.method === "COD";
  const awaiting = payment.status === "AWAITING_COLLECTION";
  const shipment = order.bangladeshShipment;
  const refused = shipment?.status === "REFUSED";
  const parcels = order.parcels.filter(parcel => !parcel.cancelledAt);
  const hasParcels = parcels.length > 0;
  const requiresParcelPreparation = parcels.some(parcel => parcel.preparationState !== null);
  const parcelDispatched = parcels.some(parcel => parcel.status !== "PLANNED");
  const pendingCancellation = order.cases[0];
  const canPack = active && !refused && !(hasParcels && parcels.every(parcelWasRefused)) && (cod || payment.status === "PAID");
  const canDispatch = canPack && !pendingCancellation && (!cod || awaiting)
    && (order.fulfillmentStatus === "READY_TO_SHIP" || order.fulfillmentStatus === "SHIPPED");
  const step = canPack && !shipment ? nextFulfillment[order.fulfillmentStatus] : undefined;
  const next = requiresParcelPreparation || hasParcels && (step === "SHIPPED" || step === "DELIVERED") ? undefined : step;
  const canCancel = !parcelDispatched && canCancelFrom.includes(order.fulfillmentStatus);
  const fulfillment = parcelDispatched ? parcelOrderLabel(parcels) : refused ? "Delivery refused" : shipment?.status === "OUT_FOR_DELIVERY"
    ? "Out for delivery" : fulfillmentLabels[order.fulfillmentStatus];
  return { active, cod, awaiting, shipment, refused, parcels, hasParcels, pendingCancellation, canPack, canDispatch, next, canCancel, fulfillment,
    due: awaiting ? payment.amountMinor : 0, requiresCodReview: cod && awaiting && parcels.some(parcelWasRefused) };
}
