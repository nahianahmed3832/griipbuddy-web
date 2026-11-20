import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { getDb } from "../db/client.ts";
import { activeSellerMarket, sellerPermissions } from "./seller-access.ts";
import { applySellerOperation, SellerHubError } from "./seller-hub.ts";

const permissions = z.array(z.enum(sellerPermissions)).min(1).max(sellerPermissions.length)
  .refine(values => values.length === new Set(values).size)
  .transform(values => values.sort());
const scope = { shopId: uuid, operationId: uuid };

const commandInput = z.discriminatedUnion("action", [
  z.object({ ...scope, action: z.literal("team.invite"), email: z.string().trim().toLowerCase().email().max(254), permissions }).strict(),
  z.object({ ...scope, action: z.literal("team.accept") }).strict(),
  z.object({ ...scope, action: z.literal("team.revoke"), memberId: z.string().min(1).max(128) }).strict(),
]);

type Db = Prisma.TransactionClient;

export async function sellerTeamPage(shopperId: string, marketId: MarketId) {
  const db = getDb();
  const [shop, invitations] = await Promise.all([
    db.marketplaceShop.findFirst({
      where: { AND: [activeSellerMarket(marketId), { ownerId: shopperId }] },
      select: { id: true, name: true, teamMembers: {
        where: { marketId, revokedAt: null }, orderBy: [{ invitedAt: "desc" }, { shopperId: "asc" }], take: 101,
        select: { shopperId: true, permissions: true, acceptedAt: true, shopper: { select: { name: true, email: true } } },
      } },
    }),
    db.marketplaceSellerMember.findMany({
      where: { shopperId, marketId, acceptedAt: null, revokedAt: null, shop: activeSellerMarket(marketId) },
      orderBy: [{ invitedAt: "desc" }, { shopId: "asc" }], take: 100,
      select: { shopId: true, shop: { select: { name: true } }, permissions: true, invitedAt: true },
    }),
  ]);
  return { shop: shop ? { ...shop, teamMembers: shop.teamMembers.slice(0, 100) } : null, invitations };
}

async function lockTeam(db: Db, shopId: string, marketId: MarketId) {
  await db.$queryRaw`SELECT id FROM "MarketplaceShop" WHERE id = ${shopId}::uuid FOR UPDATE`;
  await db.$queryRaw`SELECT "shopId" FROM "MarketplaceShopMarket"
    WHERE "shopId" = ${shopId}::uuid AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
}

export async function runSellerTeamCommand(shopperId: string, marketId: MarketId, input: unknown) {
  const parsed = commandInput.safeParse(input);
  if (!parsed.success) throw new SellerHubError(400, "Review the shop, account and permissions.");
  const command = parsed.data;
  const { shopId, action } = command;
  return getDb().$transaction(async tx => {
    await lockTeam(tx, shopId, marketId);
    const shop = await tx.marketplaceShop.findFirst({
      where: { AND: [{ id: shopId }, activeSellerMarket(marketId)] }, select: { ownerId: true },
    });
    if (!shop?.ownerId || action !== "team.accept" && shop.ownerId !== shopperId) {
      throw new SellerHubError(404, "This team is unavailable for the selected market.");
    }
    if (action === "team.accept" && !await tx.marketplaceSellerMember.findFirst({
      where: { shopId, shopperId, marketId, revokedAt: null }, select: { shopperId: true },
    })) throw new SellerHubError(404, "This invitation is unavailable.");
    return applySellerOperation(tx, "seller:" + shopperId, command.operationId, { marketId, command }, action, async () => {
      let memberId = shopperId;
      if (action === "team.invite") {
        const recipient = await tx.shopper.findFirst({ where: { email: command.email, emailVerified: true }, select: { id: true } });
        if (!recipient || recipient.id === shop.ownerId) throw new SellerHubError(422, "Use a verified team member account.");
        memberId = recipient.id;
        const key = { shopId, shopperId: memberId, marketId };
        const previous = await tx.marketplaceSellerMember.findUnique({ where: { shopId_shopperId_marketId: key } });
        if (!previous || previous.revokedAt) {
          if (await tx.marketplaceSellerMember.count({ where: { shopId, marketId, revokedAt: null } }) >= 100) {
            throw new SellerHubError(409, "This shop has reached its team limit for this market.");
          }
        }
        if (previous && !previous.revokedAt && JSON.stringify(previous.permissions) === JSON.stringify(command.permissions)) return memberId;
        const terms = { permissions: command.permissions, acceptedAt: null, revokedAt: null, invitedAt: new Date() };
        await tx.marketplaceSellerMember.upsert({ where: { shopId_shopperId_marketId: key },
          create: { ...key, ...terms }, update: terms });
      } else if (action === "team.revoke") {
        memberId = command.memberId;
        const revoked = await tx.marketplaceSellerMember.updateMany({
          where: { marketId, shopId, shopperId: memberId, revokedAt: null }, data: { revokedAt: new Date() },
        });
        if (!revoked.count) throw new SellerHubError(404, "This team member is unavailable.");
      } else {
        const accepted = await tx.marketplaceSellerMember.updateMany({
          where: { marketId, shopId, shopperId, revokedAt: null, acceptedAt: null, shopper: { emailVerified: true } },
          data: { acceptedAt: new Date() },
        });
        if (!accepted.count) throw new SellerHubError(409, "This invitation cannot be accepted again.");
      }
      await tx.auditEvent.create({ data: { action: "SELLER_TEAM_CHANGED", target: shopId, changes: {
        action, operationId: command.operationId, actor: { kind: "shopper", id: shopperId }, marketId, memberId,
        ...(action === "team.invite" && { permissions: command.permissions }),
      } } });
      return memberId;
    });
  });
}
