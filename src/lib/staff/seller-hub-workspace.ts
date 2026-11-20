import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { activeSellerMarket } from "../marketplace/seller-access.ts";
import { adminHubDetail, adminHubPage, type HubSection } from "../marketplace/seller-hub.ts";

export async function staffSellerHubWorkspace(marketId: MarketId, section: HubSection, page: number, id?: string, q?: string) {
  const [list, detail, shops] = await Promise.all([
    adminHubPage(marketId, section, page),
    id ? adminHubDetail(marketId, id) : null,
    section === "requests" ? [] : getDb().marketplaceShop.findMany({
      where: { ...activeSellerMarket(marketId), ...(q && { name: { contains: q, mode: "insensitive" } }) },
      orderBy: [{ name: "asc" }, { id: "asc" }], take: 50, select: { id: true, name: true },
    }),
  ]);
  return { ...list, detail, shops };
}
