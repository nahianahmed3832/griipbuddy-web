import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { candidate, intendedMarkets } from "../staff/merchandising.ts";
import { merchandisingEnabled, merchandisingRunnerConnection } from "../staff/merchandising-config.ts";
import { canUseMarket } from "../staff/market-access.ts";

/** Open the existing catalog employee's review surface for a verified candidate. */
export async function workflowListingHarnessLink(actorId: string, marketId: MarketId, productId: string) {
  if (!merchandisingEnabled() || !merchandisingRunnerConnection() ||
      !await canUseMarket(actorId, marketId, "merchandising")) return null;
  const db = getDb();
  const staff = await db.staffAccess.findUnique({ where: { userId: actorId }, select: { active: true, role: true } });
  if (!staff?.active || staff.role !== "OWNER") return null;
  const candidates = await db.merchandisingCandidate.findMany({ where: { productId },
    orderBy: { updatedAt: "desc" }, take: 10, select: { id: true } });
  for (const row of candidates) {
    const visible = await candidate(actorId, row.id);
    if (visible && intendedMarkets(visible.draft).includes(marketId)) {
      return `/staff/catalog/merchandising/${encodeURIComponent(row.id)}?${new URLSearchParams({ market: marketId, intent: "listing" })}`;
    }
  }
  return null;
}
