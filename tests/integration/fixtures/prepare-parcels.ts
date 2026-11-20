import { randomUUID } from "node:crypto";
import { recordOrderParcelPreparation } from "../../../src/lib/commerce/order-parcels.ts";
import { parcelItemsToShip } from "../../../src/lib/commerce/parcel-tracking.ts";
import { getDb } from "../../../src/lib/db/client.ts";

export async function parcelPreparationRequest(parcelId: string, next: "PICKED" | "PACKED") {
  const parcel = await getDb().orderParcel.findUniqueOrThrow({ where: { id: parcelId }, include: { items: true } });
  return { operationId: randomUUID(), next, expectedRevision: parcel.trackingRevision,
    items: parcelItemsToShip(parcel.items).map(({ orderItemId, quantity }) => ({ orderItemId, quantity })) };
}

export async function prepareParcel(actorId: string, orderId: string, parcelId: string) {
  await recordOrderParcelPreparation(actorId, orderId, parcelId, await parcelPreparationRequest(parcelId, "PICKED"));
  await recordOrderParcelPreparation(actorId, orderId, parcelId, await parcelPreparationRequest(parcelId, "PACKED"));
}

export async function prepareOrderParcels(actorId: string, orderId: string) {
  const parcels = await getDb().orderParcel.findMany({ where: { orderId, cancelledAt: null }, select: { id: true } });
  for (const { id } of parcels) await prepareParcel(actorId, orderId, id);
}
