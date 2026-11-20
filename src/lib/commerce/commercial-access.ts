import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { sellerVisibility } from "../marketplace/market-grants.ts";
import { firstPartyStoreMode, marketplaceMode } from "../release-config.ts";
import { authorize } from "../staff/operations.ts";
import { CatalogWriteError, OperationError } from "../staff/operation-error.ts";

export type CommercialActor = { kind: "staff"; id: string } | { kind: "seller"; id: string };

export function connectedSellerVisibility(marketId: MarketId): Prisma.MarketplaceShopWhereInput {
  return marketplaceMode() && !firstPartyStoreMode()
    ? sellerVisibility(marketId) : { id: storeShop.id, published: true };
}

export async function lockCommercialSeller(tx: Prisma.TransactionClient, sellerId: string) {
  // Existing grant commands lock the shop before changing its market permissions.
  await tx.$queryRaw`SELECT id FROM "MarketplaceShop" WHERE id = ${sellerId}::uuid FOR SHARE`;
}

export async function authorizeCommercialActor(
  tx: Prisma.TransactionClient, actor: CommercialActor, { marketId, sellerId }: { marketId: MarketId; sellerId: string },
) {
  if (!isMarketSelectable(marketId)) throw new OperationError("This market is unavailable.");
  if (actor.kind === "staff") {
    await tx.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actor.id} FOR SHARE`;
    const { role } = await authorize(tx, actor.id);
    if (role === "OWNER") return { central: true };
    const [grant] = await tx.$queryRaw<{ commercial: boolean }[]>`
      SELECT commercial FROM "StaffMarketAccess"
      WHERE "userId" = ${actor.id} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE
    `;
    if (!grant?.commercial) throw new CatalogWriteError("forbidden", "You don’t have commercial permission for this market.");
    return { central: false };
  }

  if (actor.kind !== "seller" || !marketplaceMode() || firstPartyStoreMode() || sellerId === storeShop.id) {
    throw new CatalogWriteError("forbidden", "Seller access is unavailable.");
  }
  await lockCommercialSeller(tx, sellerId);
  const shop = await tx.marketplaceShop.findFirst({
    where: { AND: [{ id: sellerId, ownerId: actor.id }, connectedSellerVisibility(marketId)] },
    select: { id: true },
  });
  if (!shop) throw new CatalogWriteError("forbidden", "This seller does not own the shop or have permission for this market.");
  return { central: false };
}
