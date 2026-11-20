import type { Prisma } from "../../generated/prisma/client.ts";
import type { OrderParcelStatus, ParcelTrackingStatus } from "../../generated/prisma/enums.ts";

export const orderParcelStatusLabels: Record<OrderParcelStatus, string> = {
  PLANNED: "Preparing for dispatch",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  REFUSED: "Delivery refused",
  RETURNED: "Returned to dispatch location",
};

export const parcelTrackingStatusLabels: Record<ParcelTrackingStatus, string> = {
  PREPARING: "Preparing",
  HANDED_TO_CARRIER: "Handed to carrier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  DELIVERY_EXCEPTION: "Delivery exception",
  RETURNED: "Returned",
};

const trackingTransitions: Record<ParcelTrackingStatus, readonly ParcelTrackingStatus[]> = {
  PREPARING: ["HANDED_TO_CARRIER", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_EXCEPTION", "RETURNED"],
  HANDED_TO_CARRIER: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_EXCEPTION", "RETURNED"],
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_EXCEPTION", "RETURNED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "DELIVERY_EXCEPTION", "RETURNED"],
  DELIVERY_EXCEPTION: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"],
  DELIVERED: [],
  RETURNED: [],
};

export function canAdvanceParcelTracking(from: ParcelTrackingStatus, to: ParcelTrackingStatus) {
  return from === to || trackingTransitions[from].includes(to);
}

export function normalizedParcelTrackingStatus(status: OrderParcelStatus): ParcelTrackingStatus {
  if (status === "PLANNED") return "PREPARING";
  if (status === "REFUSED") return "DELIVERY_EXCEPTION";
  return status;
}

export function normalizedParcelEventStatus(status: OrderParcelStatus): ParcelTrackingStatus {
  return status === "IN_TRANSIT" ? "HANDED_TO_CARRIER" : normalizedParcelTrackingStatus(status);
}

export function currentParcelTrackingStatus(parcel: { status: OrderParcelStatus; trackingStatus?: ParcelTrackingStatus | null }) {
  return parcel.trackingStatus ?? normalizedParcelTrackingStatus(parcel.status);
}

const nextStatuses = {
  PLANNED: [],
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "REFUSED"],
  DELIVERED: [],
  REFUSED: [],
  RETURNED: [],
} as const satisfies Record<OrderParcelStatus, readonly OrderParcelStatus[]>;

export function nextOrderParcelStatuses(status: OrderParcelStatus): readonly OrderParcelStatus[] {
  return nextStatuses[status];
}

export function parcelWasRefused(parcel: { status: OrderParcelStatus }) {
  return parcel.status === "REFUSED" || parcel.status === "RETURNED";
}

export function parcelOrderLabel(parcels: readonly { status: OrderParcelStatus }[]) {
  if (parcels.every(parcel => parcel.status === "PLANNED")) return "Preparing for dispatch";
  if (parcels.every(parcel => parcel.status === "RETURNED")) return "Returned to dispatch locations";
  if (parcels.every(parcelWasRefused)) return "Delivery refused";
  if (parcels.every(parcel => parcel.status === "DELIVERED")) return "Delivered";
  if (parcels.some(parcelWasRefused)) return "Delivery issue";
  if (parcels.some(parcel => parcel.status === "DELIVERED")) return "Partially delivered";
  if (parcels.some(parcel => parcel.status === "PLANNED")) return "Partially shipped";
  if (parcels.every(parcel => parcel.status === "OUT_FOR_DELIVERY")) return "Out for delivery";
  return "Shipped";
}

export const shopperParcelSummary = { select: { status: true } } satisfies Prisma.Order$parcelsArgs;

export const shopperParcelHistory = {
  orderBy: [{ locationName: "asc" }, { id: "asc" }],
  select: {
    id: true,
    locationName: true,
    status: true,
    carrier: true,
    trackingReference: true,
    source: true,
    statusUpdatedAt: true,
    trackingStatus: true,
    estimatedDeliveryAt: true,
    trackingSyncedAt: true,
    receivedAt: true,
    items: {
      orderBy: { orderItemId: "asc" },
      select: { quantity: true, orderItem: { select: { id: true, productName: true, variantName: true, sku: true } } },
    },
    events: {
      orderBy: [{ recordedAt: "asc" }, { status: "asc" }],
      select: { status: true, recordedAt: true },
    },
    trackingObservations: {
      where: { applied: true, status: { not: null } }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 25,
      select: { id: true, status: true, occurredAt: true },
    },
  },
} satisfies Prisma.Order$parcelsArgs;

export const staffParcelHistory = {
  ...shopperParcelHistory,
  select: {
    ...shopperParcelHistory.select,
    locationId: true,
    returnDisposition: true,
    trackingOccurredAt: true,
    trackingAttemptAt: true,
    trackingSyncError: true,
    trackingRevision: true,
    events: {
      ...shopperParcelHistory.select.events,
      select: { ...shopperParcelHistory.select.events.select, evidence: true, reason: true, actorId: true },
    },
    trackingObservations: {
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: 25,
      select: { id: true, status: true, source: true, actorId: true, reason: true,
        error: true, occurredAt: true, recordedAt: true, applied: true },
    },
  },
} satisfies Prisma.Order$parcelsArgs;

export type OrderParcelTracking = Prisma.OrderParcelGetPayload<{ select: typeof shopperParcelHistory.select }>;
export type OrderParcelStaffTracking = Prisma.OrderParcelGetPayload<{ select: typeof staffParcelHistory.select }>;
