import type { MarketId } from "../../config/markets.ts";
import { cache } from "react";
import { getDb } from "../db/client.ts";
import { getShopper } from "./auth.ts";
import type { MarketGrantStatus } from "./market-grants.ts";
import { resolveSellerAccess } from "./seller-access.ts";

// Memoized for one render. Every seller request resolves ownership from the session.
export const sellerWorkspace = cache(async () => {
  const shopper = await getShopper();
  const shop = shopper && await getDb().marketplaceShop.findUnique({
    where: { ownerId: shopper.id },
    select: { id: true, name: true, slug: true, published: true, about: true, announcement: true, marketGrants: true },
  });
  return { shopper, shop };
});

export function sellerMarketAccess(published: boolean, grant: MarketGrantStatus | undefined) {
  if (grant === "DENIED") return { label: "Selling restricted", tone: "muted" } as const;
  if (grant === "APPROVED" && published) return { label: "Approved to sell", tone: "positive" } as const;
  if (grant) return { label: "Pending review", tone: "warning" } as const;
  return { label: "Not enrolled", tone: "muted" } as const;
}

export const sellerListingWorkspace = cache(async (marketId: MarketId) => {
  const existing = await sellerWorkspace();
  if (existing.shop || !existing.shopper) return { ...existing, delegated: false };
  const access = await resolveSellerAccess(existing.shopper.id, marketId, "LISTINGS");
  const shop = access && await getDb().marketplaceShop.findUnique({
    where: { id: access.shop.id },
    select: { id: true, name: true, slug: true, published: true, about: true, announcement: true,
      marketGrants: { where: { marketId, status: "APPROVED" } } },
  });
  return { shopper: existing.shopper, shop, delegated: Boolean(shop) };
});
