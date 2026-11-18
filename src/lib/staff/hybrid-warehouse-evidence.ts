import { z } from "zod";

export const nativeWarehouseId = z.string().regex(/^[a-f0-9]{24}$/);
export const warehouseVariant = /^v-[a-f0-9]{24}$/;
export const warehouseDispatchKey = (orderId: string) => "dispatch:" + orderId;
export const warehouseDisposition = z.enum(["RESTOCK", "HOLD"]);
export const warehouseLine = z.object({ itemId: z.uuid(), quantity: z.int().min(1).max(10_000) });
export const warehouseEvidence = z.object({
  orderId: z.uuid(), warehouseId: nativeWarehouseId, action: z.enum(["dispatch", "return"]),
  eventId: z.string().min(1).max(100), costMinor: z.int().nonnegative().nullable(),
  disposition: warehouseDisposition.optional(), recordedAt: z.iso.datetime(),
  lines: z.array(warehouseLine.extend({ costMinor: z.int().nonnegative().nullable() })),
});

export function dispatchEvidence(raw: unknown) {
  const result = warehouseEvidence.safeParse(raw);
  return result.success && result.data.action === "dispatch" ? result.data : null;
}
