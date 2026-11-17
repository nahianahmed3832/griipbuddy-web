import type { BangladeshShipmentStatus } from "../../generated/prisma/enums.ts";

export const bangladeshTrackingLabels: Record<BangladeshShipmentStatus, string> = {
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  REFUSED: "Delivery refused",
};

const nextStatuses = {
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "REFUSED"],
  DELIVERED: [],
  REFUSED: [],
} as const satisfies Record<BangladeshShipmentStatus, readonly BangladeshShipmentStatus[]>;

export function nextBangladeshTrackingStatuses(status: BangladeshShipmentStatus): readonly BangladeshShipmentStatus[] {
  return nextStatuses[status];
}
