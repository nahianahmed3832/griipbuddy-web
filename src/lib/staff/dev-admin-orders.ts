import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
import { bangladeshStaffTrackingHistory } from "../commerce/bangladesh-shipment.ts";
import { storeShop } from "../marketplace/constants.ts";
import { hybridDemoMode } from "../release-config.ts";

const tokenFormat = /^[a-f0-9]{64}$/;
const idFormat = z.uuid();

export function canReadDevAdminOrders(authorization: string | null) {
  if (process.env.COMMERCE_MODE !== "staging" || !hybridDemoMode()) return false;
  const expected = process.env.GRIIP_HYBRID_ADMIN_ORDERS_TOKEN ?? "";
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  return tokenFormat.test(expected) && tokenFormat.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

const firstParty = { OR: [{ marketplaceShopId: null }, { marketplaceShopId: storeShop.id }] } satisfies Prisma.OrderItemWhereInput;
export const devAdminOrderScope = {
  marketId: "bd", currency: "BDT", measurementTest: true, items: { some: firstParty, every: firstParty },
} satisfies Prisma.OrderWhereInput;

const summary = {
  id: true, reference: true, createdAt: true, status: true, fulfillmentStatus: true,
  districtLabel: true, currency: true, totalMinor: true,
  payment: { select: { method: true, status: true } }, _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

type Summary = Prisma.OrderGetPayload<{ select: typeof summary }>;
function orderSummary<T extends Summary>({ _count, createdAt, ...order }: T) {
  return { ...order, createdAt: createdAt.toISOString(), itemCount: _count.items };
}

const itemSnapshot = {
  productName: true, variantName: true, sku: true, quantity: true,
  unitPriceMinor: true, unitDiscountMinor: true, lineTotalMinor: true,
} satisfies Prisma.OrderItemSelect;
const currentReturnCases = { kind: "RETURN", OR: [{ status: { in: ["OPEN", "IN_REVIEW", "RETURN_APPROVED"] } }, { returnReceivedAt: { not: null } }] } satisfies Prisma.OrderCaseWhereInput;
const workspaceSummary = {
  ...summary, shippingWarehouseId: true, shippingWarehouseName: true,
  payment: { select: { method: true, status: true, amountMinor: true, collectedAt: true } },
  bangladeshShipment: { select: { status: true, carrier: true, trackingReference: true } },
  bangladeshRefusedParcelReceipt: { select: { receivedAt: true, disposition: true, restockedUnits: true } },
  items: { orderBy: { id: "asc" }, select: itemSnapshot },
  cases: { where: currentReturnCases, select: { status: true, returnReceivedAt: true, returnLines: { select: { quantity: true } } } },
} satisfies Prisma.OrderSelect;
const detail = {
  ...workspaceSummary, subtotalMinor: true, discountMinor: true, deliveryMinor: true, taxMinor: true,
  bangladeshShipment: bangladeshStaffTrackingHistory,
  bangladeshRefusedParcelReceipt: { select: { ...workspaceSummary.bangladeshRefusedParcelReceipt.select, note: true } },
  payment: { select: { ...workspaceSummary.payment.select, manualProof: {
    select: { test: true, reviewedAt: true, submittedTransaction: true },
  } } },
  events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: {
    status: true, type: true, createdAt: true, actor: { select: { name: true } },
  } },
} satisfies Prisma.OrderSelect;
const reportItem = { ...itemSnapshot, variantId: true, variant: { select: { productId: true,
  product: { select: { department: { select: { id: true, name: true } } } },
} } } satisfies Prisma.OrderItemSelect;
const reportingSummary = {
  ...workspaceSummary, deliveryMinor: true,
  items: { ...workspaceSummary.items, select: reportItem },
  bangladeshShipment: { select: { ...workspaceSummary.bangladeshShipment.select, statusUpdatedAt: true,
    events: { select: { status: true, recordedAt: true } },
  } },
  events: { where: { type: "STATUS_CHANGED" }, select: { status: true, createdAt: true } },
  cases: { where: currentReturnCases, select: {
    status: true, returnReceivedAt: true, refundConfirmedAt: true, refundAmountMinor: true, createdAt: true,
    returnLines: { select: { quantity: true, orderItem: { select: reportItem } } },
  } },
} satisfies Prisma.OrderSelect;

type Cursor = { createdAt: Date; id: string };
const warehouseIds = z.string().max(499).regex(/^[a-f0-9]{24}(,[a-f0-9]{24})*$/).transform(value => [...new Set(value.split(","))]);
const workspace = z.object({
  view: z.literal("workspace"), q: z.string().trim().max(100).optional(), sku: z.string().trim().max(100).optional(),
  locations: warehouseIds.optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), creator: z.enum(["USER", "GUEST"]).optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to);
const reporting = z.object({
  view: z.literal("reporting"), locations: warehouseIds.optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  active: z.literal("1").optional(), costs: z.literal("1").optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to);
type OrderQuery = { kind: "detail"; id: string; costs?: boolean } | { kind: "list"; limit: number; search: string; after?: Cursor } |
  { kind: "workspace"; filters: z.infer<typeof workspace> } | { kind: "reporting"; filters: z.infer<typeof reporting> };
const workspaceLimit = 10_000;

function decodeCursor(value: string): Cursor | undefined {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(value)) return;
  const [timestamp, id, extra] = Buffer.from(value, "base64url").toString().split("|");
  const createdAt = new Date(timestamp);
  if (extra !== undefined || !idFormat.safeParse(id).success || !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== timestamp) return;
  return { createdAt, id };
}

function encodeCursor(row: Cursor) {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

export function readDevAdminOrderQuery(params: URLSearchParams): OrderQuery | null {
  const provided = [...params.keys()];
  if (new Set(provided).size !== provided.length) return null;
  if (params.get("view") === "workspace") {
    const parsed = workspace.safeParse(Object.fromEntries(params));
    return parsed.success ? { kind: "workspace", filters: parsed.data } : null;
  }
  if (params.get("view") === "reporting") {
    const parsed = reporting.safeParse(Object.fromEntries(params));
    return parsed.success ? { kind: "reporting", filters: parsed.data } : null;
  }
  const allowed = ["id", "limit", "search", "after", "costs"];
  if (provided.some(key => !allowed.includes(key))) return null;
  const id = params.get("id");
  const costs = params.get("costs");
  if (id !== null) {
    return idFormat.safeParse(id).success && provided.every(key => key === "id" || key === "costs") && (costs === null || costs === "1")
      ? { kind: "detail", id, ...(costs && { costs: true }) } : null;
  }
  if (costs !== null) return null;
  const limit = params.get("limit") ?? "30";
  const search = params.get("search")?.trim() ?? "";
  const cursor = params.get("after");
  const after = cursor === null ? undefined : decodeCursor(cursor);
  if (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50 || !/^[a-z0-9-]{0,40}$/i.test(search) || (cursor !== null && !after)) return null;
  return { kind: "list", limit: Number(limit), search, after };
}

export async function readDevAdminOrders(db: DbReader, query: OrderQuery) {
  if (query.kind === "detail") {
    const readCost = query.costs === true;
    const returnCost = readCost && { select: { amountMinor: true, evidenceReference: true } };
    const row = await db.order.findFirst({ where: { ...devAdminOrderScope, id: query.id }, select: {
      ...detail, bangladeshRefusedParcelReceipt: { select: { ...detail.bangladeshRefusedParcelReceipt.select, returnCost } },
      cases: { ...detail.cases, select: { ...detail.cases.select, id: readCost, returnDisposition: readCost, returnCost } },
    } });
    if (!row) return null;
    const { items, subtotalMinor, discountMinor, deliveryMinor, taxMinor, payment, ...summaryFields } = row;
    const manualProof = payment?.manualProof;
    const manualPayment = manualProof?.test && !manualProof.reviewedAt ? { transaction: manualProof.submittedTransaction } : null;
    const order = orderSummary({ ...summaryFields, payment: payment ? {
      method: payment.method, status: payment.status, amountMinor: payment.amountMinor, collectedAt: payment.collectedAt,
    } : null });
    return { ...order, subtotalMinor, discountMinor, deliveryMinor, taxMinor, items, manualPayment };
  }
  if (query.kind === "workspace") {
    const { q, sku, from, to, creator, locations } = query.filters;
    const contains = (value: string) => ({ contains: value.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const });
    const start = from && new Date(from + "T00:00:00.000+06:00");
    const end = to && new Date(to + "T23:59:59.999+06:00");
    const orders = await db.order.findMany({
      where: { ...devAdminOrderScope,
        ...(locations && { shippingWarehouseId: { in: locations } }),
        ...(q && { reference: contains(q) }),
        ...(sku && { items: { every: firstParty, some: { ...firstParty, sku: contains(sku) } } }),
        ...((start || end) && { createdAt: { ...(start && { gte: start }), ...(end && { lte: end }) } }),
        ...(creator && { shopperId: creator === "USER" ? { not: null } : null }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: workspaceLimit + 1, select: workspaceSummary,
    });
    return { workspaceOrders: orders.length > workspaceLimit ? [] : orders.map(orderSummary), tooMany: orders.length > workspaceLimit };
  }

  if (query.kind === "reporting") {
    const { from, to, active, locations, costs } = query.filters;
    const range = { ...(from && { gte: new Date(from + "T00:00:00.000+06:00") }),
      ...(to && { lte: new Date(to + "T23:59:59.999+06:00") }) };
    const dated: Prisma.OrderWhereInput[] = from || to ? [
      { createdAt: range },
      { events: { some: { type: "STATUS_CHANGED", status: { in: ["SHIPPED", "DELIVERED"] }, createdAt: range } } },
      { bangladeshShipment: { events: { some: { status: { in: ["IN_TRANSIT", "DELIVERED"] }, recordedAt: range } } } },
      { bangladeshRefusedParcelReceipt: { receivedAt: range } },
      { cases: { some: { kind: "RETURN", OR: [{ returnReceivedAt: range }, { refundConfirmedAt: range }] } } },
    ] : [];
    const current: Prisma.OrderWhereInput[] = active ? [
      { status: "PLACED", fulfillmentStatus: { not: "DELIVERED" } },
      { cases: { some: { kind: "RETURN", status: { in: ["OPEN", "IN_REVIEW", "RETURN_APPROVED"] } } } },
    ] : [];
    const matched = [...dated, ...current];
    const returnCost = costs === "1" && { select: { amountMinor: true } };
    const rows = await db.order.findMany({ where: { ...devAdminOrderScope,
      ...(locations && { shippingWarehouseId: { in: locations } }), ...(matched.length && { OR: matched }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: workspaceLimit + 1, select: {
        ...reportingSummary,
        bangladeshRefusedParcelReceipt: { select: { ...reportingSummary.bangladeshRefusedParcelReceipt.select, returnCost } },
        cases: { ...reportingSummary.cases, select: { ...reportingSummary.cases.select, returnDisposition: true, returnCost } },
      } });
    return { reportOrders: rows.length > workspaceLimit ? [] : rows.map(orderSummary), tooMany: rows.length > workspaceLimit };
  }

  const { limit, search, after } = query;
  const rows = await db.order.findMany({
    where: { ...devAdminOrderScope, ...(search && { reference: { startsWith: search, mode: "insensitive" } }),
      ...(after && { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, select: summary,
  });
  const orders = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(orders[orders.length - 1]) : null;
  return { orders: orders.map(orderSummary), nextCursor };
}
