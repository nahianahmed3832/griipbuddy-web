import { marketList, type MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";

export type MarketStaffPermission = "merchandising" | "reporting" | "operations" | "commercial";

export async function staffMarketIds(actorId: string, permission: MarketStaffPermission, db: DbReader = getDb()): Promise<MarketId[]> {
  const staff = await db.staffAccess.findUnique({
    where: { userId: actorId },
    select: { active: true, role: true, marketGrants: { where: { [permission]: true }, select: { marketId: true } } },
  });
  if (!staff?.active) return [];
  return staff.role === "OWNER" ? marketList.map(market => market.id) : staff.marketGrants.map(grant => grant.marketId);
}

export async function canUseMarket(actorId: string, marketId: MarketId, permission: MarketStaffPermission, db?: DbReader) {
  return (await staffMarketIds(actorId, permission, db)).includes(marketId);
}
