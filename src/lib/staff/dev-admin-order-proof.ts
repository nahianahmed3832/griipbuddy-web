import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { caseReasons, ownerCaseStatuses, returnLines } from "../marketplace/case-policy.ts";

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
  canRecordReturnCost: z.boolean().optional(),
}).strict();

const text = z.string().trim().min(1).max(500);
export const returnCostCommand = z.object({
  action: z.literal("record-return-cost"), caseId: z.uuid().optional(),
  amountMinor: z.number().int().min(0).max(2147483647),
  evidence: z.string().trim().min(3).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u),
}).strict();
const tracking = z.enum(["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"]);
const caseRevision = { caseId: z.uuid(), revision: z.int().nonnegative() };
const caseNote = z.string().trim().min(3).max(1500);
const singleLine = (max: number) => z.string().trim().min(2).max(max).regex(/^[^\p{Cc}]+$/u);
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit-contact"), name: singleLine(120), phone: z.string().regex(/^(?:\+?88)?01\d{9}$/),
    address: z.string().trim().min(1).max(450), revision: z.iso.datetime() }).strict(),
  z.object({ action: z.literal("add-note"), note: z.string().trim().min(1).max(1000), key: z.uuid() }).strict(),
  z.object({ action: z.literal("open-return"), reason: z.enum(caseReasons), note: z.string().trim().min(10).max(1500), lines: returnLines }).strict(),
  z.object({ action: z.literal("review-return"), ...caseRevision, status: z.enum(ownerCaseStatuses), note: caseNote }).strict(),
  z.object({ action: z.literal("receive-return"), ...caseRevision, disposition: z.enum(["RESTOCK", "HOLD"]), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("confirm-return-refund"), ...caseRevision, amountMinor: z.int().min(1).max(2_147_483_647),
    method: singleLine(60), reference: singleLine(80), confirmed: z.literal(true) }).strict(),
  returnCostCommand,
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

function validDevAdminProof(body: string, header: string | null, purpose: string, now: number) {
  const secret = process.env.GRIIP_HYBRID_ADMIN_FULFILLMENT_TOKEN ?? "";
  if (!tokenFormat.test(secret) || !header) return null;
  const [timestamp, signature, extra] = header.split(".");
  if (extra !== undefined || !/^\d{10}$/.test(timestamp) || !tokenFormat.test(signature ?? "")) return null;
  const elapsed = Math.floor(now / 1000) - Number(timestamp);
  if (elapsed > maxProofAge || elapsed < -clockSkew) return null;

  const expected = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(purpose + "\n" + timestamp + "\n" + body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function validDevAdminDetailProof(query: string, header: string | null, now = Date.now()) {
  return validDevAdminProof(query, header, "griipbuddy/hybrid-order-details/v1", now);
}

export function readDevAdminOrderProof(body: string, header: string | null, now = Date.now()) {
  if (!validDevAdminProof(body, header, "griipbuddy/hybrid-fulfillment/v1", now)) return null;
  try {
    const result = proof.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
