import { z } from "zod";
import { hybridDemoMode } from "../release-config.ts";

export const legacyKind = z.enum(["order", "preorder"]);
export const legacyId = z.string().regex(/^[a-f0-9]{24}$/);
export const legacyCursor = z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/);

const item = z.object({
  name: z.string(),
  sku: z.string().nullable().optional(),
  quantity: z.number().int().positive(),
});
const order = z.object({
  id: legacyId,
  kind: legacyKind,
  reference: z.string(),
  createdAt: z.iso.datetime(),
  status: z.string(),
  statusLabel: z.string(),
  paymentLabel: z.string().nullable(),
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.literal("BDT"),
  trackingCode: z.string().nullable(),
  items: z.array(item),
  history: z.array(z.object({ status: z.string(), statusLabel: z.string(), createdAt: z.iso.datetime() })).optional(),
});

export type LegacyOrder = z.infer<typeof order>;
export type LegacyKind = z.infer<typeof legacyKind>;
type Access = { legacyCustomerId: string | null; grants: { kind: LegacyKind; id: string }[] };

export function bdOrderHubConfig() {
  if (process.env.BD_ORDER_HUB_MODE !== "isolated" || process.env.SHOPPER_MAIL_MODE !== "preview" || !hybridDemoMode()) return null;
  const token = process.env.BD_ORDER_HUB_BRIDGE_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  try {
    const origin = new URL(process.env.BD_ORDER_HUB_BRIDGE_URL ?? "");
    const hosts = process.env.COMMERCE_MODE === "local" ? ["127.0.0.1", "localhost", "[::1]"] : ["bd-order-hub-api"];
    if (origin.protocol !== "http:" || !hosts.includes(origin.hostname) ||
        origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) return null;
    return { origin, token };
  } catch {
    return null;
  }
}

export class OrderHubBridgeError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Bangladesh order history request failed.");
    this.status = status;
  }
}

async function bridge<T>(action: string, body: object, schema: z.ZodType<T>): Promise<T> {
  const config = bdOrderHubConfig();
  if (!config) throw new OrderHubBridgeError(503);
  const response = await fetch(new URL(`/api/v1/customer-orders/${action}`, config.origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new OrderHubBridgeError(response.status);
  return z.object({ success: z.literal(true), data: schema }).parse(await response.json()).data;
}

export function linkLegacyCustomer(phone: string, password: string) {
  return bridge("link", { phone, password }, z.object({ legacyCustomerId: legacyId }));
}

export function legacyOrderHistory(access: Access, kind?: LegacyKind, before?: string) {
  return bridge("history", { ...access, kind, before, limit: 20 }, z.object({
    items: z.array(order), next: legacyCursor.nullish(),
  }));
}

export function legacyOrderDetail(access: Access, kind: LegacyKind, id: string) {
  return bridge("detail", { ...access, kind, id }, order);
}

export async function matchLegacyRecovery(kind: LegacyKind, reference: string, channel: "email" | "sms", value: string) {
  const { id } = await bridge("resolve-recovery", { kind, reference, contact: { channel, value } }, z.object({ id: legacyId.nullable() }));
  return id;
}
