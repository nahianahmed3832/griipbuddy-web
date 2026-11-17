import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
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
const scope = {
  marketId: "bd", currency: "BDT", measurementTest: true, items: { some: firstParty, every: firstParty },
} satisfies Prisma.OrderWhereInput;

const summary = {
  id: true, reference: true, createdAt: true, status: true, fulfillmentStatus: true,
  districtLabel: true, currency: true, totalMinor: true,
  payment: { select: { method: true, status: true } }, _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

type Summary = Prisma.OrderGetPayload<{ select: typeof summary }>;
const orderSummary = ({ _count, createdAt, ...order }: Summary) => ({ ...order, createdAt: createdAt.toISOString(), itemCount: _count.items });

const detail = {
  ...summary, subtotalMinor: true, discountMinor: true, deliveryMinor: true, taxMinor: true,
  items: { orderBy: { id: "asc" }, select: {
    productName: true, variantName: true, sku: true, quantity: true,
    unitPriceMinor: true, unitDiscountMinor: true, lineTotalMinor: true,
  } },
} satisfies Prisma.OrderSelect;

type Cursor = { createdAt: Date; id: string };
type OrderQuery = { kind: "detail"; id: string } | { kind: "list"; limit: number; search: string; after?: Cursor };

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
  const allowed = ["id", "limit", "search", "after"];
  const provided = [...params.keys()];
  if (new Set(provided).size !== provided.length || provided.some(key => !allowed.includes(key))) return null;
  const id = params.get("id");
  if (id !== null) return provided.length === 1 && idFormat.safeParse(id).success ? { kind: "detail", id } : null;
  const limit = params.get("limit") ?? "30";
  const search = params.get("search")?.trim() ?? "";
  const cursor = params.get("after");
  const after = cursor === null ? undefined : decodeCursor(cursor);
  if (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50 || !/^[a-z0-9-]{0,40}$/i.test(search) || (cursor !== null && !after)) return null;
  return { kind: "list", limit: Number(limit), search, after };
}

export async function readDevAdminOrders(db: DbReader, query: OrderQuery) {
  if (query.kind === "detail") {
    const row = await db.order.findFirst({ where: { ...scope, id: query.id }, select: detail });
    if (!row) return null;
    const { items, subtotalMinor, discountMinor, deliveryMinor, taxMinor, ...summaryFields } = row;
    const order = orderSummary(summaryFields);
    return { ...order, subtotalMinor, discountMinor, deliveryMinor, taxMinor, items };
  }

  const { limit, search, after } = query;
  const rows = await db.order.findMany({
    where: { ...scope, ...(search && { reference: { startsWith: search, mode: "insensitive" } }),
      ...(after && { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, select: summary,
  });
  const orders = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(orders[orders.length - 1]) : null;
  return { orders: orders.map(orderSummary), nextCursor };
}
