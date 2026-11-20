import { type MarketId } from "../../config/markets.ts";
import { activeStaffActor } from "../access/actors.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable, selectableMarkets } from "../market-config.ts";

export type MarketStaffPermission = "merchandising" | "reporting" | "operations" | "commercial";

export async function staffMarketIds(actorId: string, permission: MarketStaffPermission, db: DbReader = getDb()): Promise<MarketId[]> {
  const staff = await db.staffAccess.findUnique({
    where: { userId: actorId },
    select: { userId: true, active: true, role: true, marketGrants: { where: { [permission]: true }, select: { marketId: true } } },
  });
  const actor = activeStaffActor(staff);
  if (!staff || !actor) return [];
  return actor.kind === "core-admin" ? selectableMarkets().map(market => market.id)
    : staff.marketGrants.map(grant => grant.marketId).filter(isMarketSelectable);
}

export async function canUseMarket(actorId: string, marketId: MarketId, permission: MarketStaffPermission, db?: DbReader) {
  return (await staffMarketIds(actorId, permission, db)).includes(marketId);
}
