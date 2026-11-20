import { markets, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { activeCaseStatuses } from "./case-policy.ts";

const pageSize = 20;

function caseScope(shopId: string, marketId: MarketId) {
  const item = { marketplaceShopId: shopId, currency: markets[marketId].currency };
  const line = { orderItem: item };
  return {
    item, line,
    where: {
      kind: { in: ["CANCEL", "RETURN", "EXCHANGE"] },
      order: { marketId, currency: item.currency, items: { some: item } },
      returnLines: { some: line },
    } satisfies Prisma.OrderCaseWhereInput,
  };
}

const summary = {
  id: true, kind: true, status: true, updatedAt: true,
  order: { select: { id: true, reference: true } },
} satisfies Prisma.OrderCaseSelect;

export async function sellerCasePage(shopId: string, marketId: MarketId, page: number, options: { all?: boolean; q?: string }) {
  const { where, line } = caseScope(shopId, marketId);
  const rows = await getDb().orderCase.findMany({
    where: {
      ...where,
      ...(!options.all && { status: { in: [...activeCaseStatuses] } }),
      order: { ...where.order, ...(options.q && { reference: { contains: options.q, mode: "insensitive" } }) },
    },
    select: { ...summary, returnLines: { where: line, select: { quantity: true } } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
  });
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export function sellerCaseDetail(shopId: string, marketId: MarketId, caseId: string) {
  const { where, line } = caseScope(shopId, marketId);
  return getDb().orderCase.findFirst({
    where: { ...where, id: caseId },
    select: {
      ...summary, revision: true,
      returnLines: {
        where: line, orderBy: { orderItemId: "asc" },
        select: { quantity: true, orderItem: { select: { id: true, productName: true, variantName: true, sku: true } } },
      },
      events: { orderBy: { revision: "asc" }, select: { revision: true, status: true, createdAt: true } },
    },
  });
}
