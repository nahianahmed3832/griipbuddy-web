import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { hybridDemoMode } from "../release-config.ts";
import {
  dispatchEvidence, nativeWarehouseId, warehouseDispatchKey, warehouseDisposition, warehouseEvidence,
  warehouseLine, warehouseVariant,
} from "./hybrid-warehouse-evidence.ts";
import { OperationError } from "./operations.ts";

const hexToken = /^[a-f0-9]{64}$/;
const trackingTimeout = 8_000;
export const warehouseTransactionOptions = { timeout: 15_000 };
const label = z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/u);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dispatch"), orderId: z.uuid(), reference: label,
    warehouseId: nativeWarehouseId, operatorId: nativeWarehouseId,
    lines: z.array(warehouseLine.extend({ variantId: z.string().regex(warehouseVariant), sku: label })).min(1).max(100) }),
  z.object({ action: z.literal("return"), orderId: z.uuid(), receiptId: z.uuid(), warehouseId: nativeWarehouseId,
    operatorId: nativeWarehouseId.optional(), ownerActorId: label.optional(),
    disposition: warehouseDisposition, lines: z.array(warehouseLine).min(1).max(100) }),
]);
export type WarehouseRequest = z.infer<typeof requestSchema>;
type ReturnRequest = Extract<WarehouseRequest, { action: "return" }>;
type WarehouseEvidence = z.infer<typeof warehouseEvidence>;
const rejectedSchema = z.object({ writeState: z.literal("rejected"), message: z.string().min(1).max(700) });

function warehouseConnection() {
  const url = process.env.GRIIP_HYBRID_INVENTORY_ORIGIN;
  const token = process.env.GRIIP_HYBRID_INVENTORY_TOKEN;
  if (!url && !token) return null;
  const internal = url === "http://hybrid-inventory-api:38100";
  const local = /^http:\/\/127\.0\.0\.1:38\d{3}$/.test(url ?? "");
  if (!url || !token || !hybridDemoMode() || !hexToken.test(token) ||
    !(process.env.COMMERCE_MODE === "staging" && internal ||
      local && (process.env.COMMERCE_MODE === "local" || process.env.NODE_ENV === "test"))) {
    throw new OperationError("The protected warehouse connection is unavailable.", 503);
  }
  return { url, token };
}

export function warehouseInventoryEnabled() {
  return warehouseConnection() !== null;
}

export const warehouseReturnKey = (receiptId: string) => "return:" + receiptId;
export const warehouseRefusedKey = (orderId: string) => "refused:" + orderId;
export const warehouseFingerprint = (values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");

const stepMarker = Symbol("warehouse posting");
type WarehouseStep = { [stepMarker]: true; error?: OperationError };
function warehouseStep(error?: OperationError): WarehouseStep {
  return { [stepMarker]: true, ...(error && { error }) };
}
function isWarehouseStep(value: unknown): value is WarehouseStep {
  return !!value && typeof value === "object" && stepMarker in value;
}

export async function runWarehouseOperation<T>(operation: (complete: boolean) => Promise<T | WarehouseStep>): Promise<T> {
  let result = await operation(false);
  if (!isWarehouseStep(result)) return result;
  if (result.error) throw result.error;
  result = await operation(true);
  if (!isWarehouseStep(result)) return result;
  throw result.error ?? new OperationError("Could not confirm the warehouse movement. Retry the same action.", 503);
}

export async function ensureNoPendingWarehousePosting(tx: Prisma.TransactionClient, orderId: string, allowedKey?: string) {
  const pending = await tx.hybridWarehousePosting.findFirst({
    where: { orderId, completedAt: null, ...(allowedKey && { key: { not: allowedKey } }) }, select: { key: true },
  });
  if (pending) throw new OperationError("Complete the pending warehouse movement before changing this order.");
}

function readEvidence(request: WarehouseRequest, raw: unknown) {
  const parsed = warehouseEvidence.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.action !== request.action || data.orderId !== request.orderId || data.warehouseId !== request.warehouseId ||
      (request.action === "return" && data.disposition !== request.disposition) || data.lines.length !== request.lines.length) return null;
  const recorded = new Map(data.lines.map(row => [row.itemId, row.quantity]));
  if (recorded.size !== data.lines.length || request.lines.some(row => recorded.get(row.itemId) !== row.quantity)) return null;
  const total = data.lines.every(row => row.costMinor !== null) ? data.lines.reduce((sum, row) => sum + (row.costMinor ?? 0), 0) : null;
  return total === data.costMinor ? data : null;
}

// This runs with the Hybrid order row locked. The first transaction leaves an
// immutable intent before any network call. The retry always sends that same
// intent and only commits the evidence alongside the matching local operation.
export async function postWarehouseMovement(tx: Prisma.TransactionClient, draft: {
  key: string; fingerprint: string; request: WarehouseRequest; trackingReference?: string;
}, complete: boolean): Promise<WarehouseStep | { evidence: WarehouseEvidence }> {
  const { key, fingerprint, request, trackingReference } = draft;
  const connection = warehouseConnection();
  if (!connection) throw new OperationError("The protected warehouse connection is unavailable.", 503);
  await ensureNoPendingWarehousePosting(tx, request.orderId, key);
  const existing = await tx.hybridWarehousePosting.findUnique({ where: { key } });
  if (existing && (existing.orderId !== request.orderId || existing.fingerprint !== fingerprint)) {
    throw new OperationError("This movement already has a different request. Retry its original options.");
  }
  if (!existing) {
    if (complete) throw new OperationError("The pending movement changed. Refresh the order.");
    await tx.hybridWarehousePosting.create({ data: { key, fingerprint, orderId: request.orderId, request, trackingReference } });
  }
  const saved = requestSchema.safeParse(existing?.request ?? request);
  if (!saved.success) throw new OperationError("The pending warehouse request needs review.", 503);
  if (existing?.completedAt) {
    const evidence = readEvidence(saved.data, existing.evidence);
    if (evidence) return { evidence };
    throw new OperationError("The recorded warehouse movement needs review.", 503);
  }
  if (!complete) return warehouseStep();
  const response = await fetch(connection.url + "/api/v1/internal/hybrid-inventory", {
    method: "POST", headers: { authorization: "Bearer " + connection.token, "content-type": "application/json" },
    body: JSON.stringify(saved.data), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(trackingTimeout),
  }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response?.ok) {
    const rejected = rejectedSchema.safeParse(payload);
    if (rejected.success && response && response.status >= 400 && response.status < 500) {
      await tx.hybridWarehousePosting.delete({ where: { key } });
      return warehouseStep(new OperationError(rejected.data.message, response.status));
    }
    throw new OperationError("Could not confirm the warehouse movement. Retry the same action.", 503);
  }
  const evidence = payload?.success === true && readEvidence(saved.data, payload.data);
  if (!evidence) throw new OperationError("The warehouse response could not be confirmed. Retry the same action.", 503);
  await tx.hybridWarehousePosting.update({ where: { key }, data: { evidence, completedAt: new Date() } });
  return { evidence };
}

export async function warehouseReturnRequest(tx: Prisma.TransactionClient, orderId: string, receiptId: string,
  lines: ReturnRequest["lines"], returnDisposition: ReturnRequest["disposition"],
  operator: Pick<ReturnRequest, "operatorId" | "ownerActorId">): Promise<ReturnRequest | null> {
  const posting = await tx.hybridWarehousePosting.findUnique({ where: { key: warehouseDispatchKey(orderId) }, select: { evidence: true, completedAt: true } });
  if (!posting?.completedAt) return null;
  const dispatch = dispatchEvidence(posting.evidence);
  if (!dispatch) throw new OperationError("The original warehouse movement needs review.", 503);
  const managed = new Set(dispatch.lines.map(row => row.itemId));
  const tracked = lines.filter(row => managed.has(row.itemId));
  return tracked.length ? { action: "return", orderId, warehouseId: dispatch.warehouseId, receiptId, ...operator,
    disposition: returnDisposition, lines: tracked } : null;
}

export async function recordWarehouseReturnCost(tx: Prisma.TransactionClient, movement: WarehouseEvidence | undefined, returnedUnits: number,
  receipt: { caseId: string } | { refusedOrderId: string }) {
  if (movement?.disposition !== "RESTOCK" || movement.costMinor == null || movement.costMinor > 2_147_483_647 ||
      movement.lines.reduce((sum, row) => sum + row.quantity, 0) !== returnedUnits) return;
  await tx.hybridReturnCost.create({ data: { ...receipt, amountMinor: movement.costMinor,
    evidenceReference: "Warehouse movement " + movement.eventId } });
}
