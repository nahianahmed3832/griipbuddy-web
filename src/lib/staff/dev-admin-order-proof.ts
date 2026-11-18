import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const tokenFormat = /^[a-f0-9]{64}$/;
const maxProofAge = 30;
const clockSkew = 5;
const id = z.uuid();

const warehouseId = z.string().regex(/^[a-f0-9]{24}$/);
export const devAdminWarehouse = z.object({
  id: warehouseId,
  name: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u),
}).strict();

const operator = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  name: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u),
  canReturn: z.boolean(),
  assignedWarehouseId: warehouseId.optional(),
}).strict();

const text = z.string().trim().min(1).max(500);
const tracking = z.enum(["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"]);
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("advance"), next: z.enum(["PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED"]),
    carrier: text.optional(), trackingReference: text.optional(), simulate: z.boolean().optional(),
    warehouse: devAdminWarehouse.optional() }).strict(),
  z.object({ action: z.literal("track"), status: tracking, evidence: text.optional() }).strict(),
  z.object({ action: z.literal("receive"), disposition: z.enum(["RESTOCK", "HOLD"]), note: text }).strict(),
  z.object({ action: z.literal("collect"), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("cancel"), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("approve-wallet"), amountMinor: z.number().int().positive().max(2147483647), transaction: text,
    confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("decline-wallet"), note: text, confirm: z.literal(true) }).strict(),
]);

const proof = z.object({ id, operator, command }).strict();

export type DevAdminFulfillmentOperator = z.infer<typeof operator>;
export type DevAdminOrderCommand = z.infer<typeof command>;

export function readDevAdminOrderProof(body: string, header: string | null, now = Date.now()) {
  const secret = process.env.GRIIP_HYBRID_ADMIN_FULFILLMENT_TOKEN ?? "";
  if (!tokenFormat.test(secret) || !header) return null;
  const [timestamp, signature, extra] = header.split(".");
  if (extra !== undefined || !/^\d{10}$/.test(timestamp) || !tokenFormat.test(signature ?? "")) return null;
  const elapsed = Math.floor(now / 1000) - Number(timestamp);
  if (elapsed > maxProofAge || elapsed < -clockSkew) return null;

  const expected = createHmac("sha256", Buffer.from(secret, "hex"))
    .update("griipbuddy/hybrid-fulfillment/v1\n" + timestamp + "\n" + body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  try {
    const result = proof.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
