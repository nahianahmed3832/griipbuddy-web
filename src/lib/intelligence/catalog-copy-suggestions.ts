import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { localDatabase } from "../db/local.ts";
import { isMarketSelectable } from "../market-config.ts";
import { getSellerAccess, lockSellerScope } from "../marketplace/seller-access.ts";
import { canUseMarket } from "../staff/market-access.ts";

export type CopyActor = { kind: "staff"; id: string } | { kind: "seller"; id: string; shopId: string };
export const copyInput = z.strictObject({
  operationId: z.uuid(), productId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  purpose: z.enum(["summary", "description"]),
});
const plainCopy = z.string().trim().min(10).max(900).regex(/^[^<>\p{Cc}]+$/u);
const details = { operationId: true, productId: true, productRevision: true, purpose: true, state: true,
  createdAt: true, body: true } as const;

export function catalogCopyFixture() {
  if (localDatabase() !== "griipbuddy_test" || process.env.GRIIP_M11_CATALOG_COPY !== "fixture") return null;
  const mode = process.env.GRIIP_M11_CATALOG_COPY_RESULT ?? "ready";
  return ["ready", "timeout", "invalid"].includes(mode) ? mode : null;
}

async function copyScope(db: Prisma.TransactionClient, actor: CopyActor, marketId: MarketId, locked: boolean) {
  if (!isMarketSelectable(marketId)) return null;
  if (actor.kind === "staff" && !await canUseMarket(actor.id, marketId, "merchandising", db)) return null;
  if (actor.kind === "seller") {
    if (!z.uuid().safeParse(actor.shopId).success) return null;
    if (locked) await lockSellerScope(db, actor.shopId, marketId);
    if (!await getSellerAccess(actor.id, actor.shopId, marketId, "LISTINGS", db)) return null;
  }
  return { actorKind: actor.kind, actorId: actor.id, marketId, shopId: actor.kind === "seller" ? actor.shopId : null };
}

export async function catalogCopyHistory(actor: CopyActor, marketId: MarketId) {
  return getDb().$transaction(async db => {
    const scope = await copyScope(db, actor, marketId, false);
    return scope ? db.catalogCopySuggestion.findMany({
      where: scope, select: details, orderBy: [{ createdAt: "desc" }, { operationId: "desc" }], take: 12,
    }) : null;
  }, { isolationLevel: "RepeatableRead" });
}

export async function saveCatalogCopySuggestion(actor: CopyActor, marketId: MarketId, raw: unknown) {
  const mode = catalogCopyFixture();
  if (!mode) return { kind: "disabled" } as const;
  const validated = copyInput.safeParse(raw);
  if (!validated.success) return { kind: "invalid" } as const;
  const { operationId, productId, purpose } = validated.data;
  return getDb().$transaction(async db => {
    const scope = await copyScope(db, actor, marketId, true);
    if (!scope) return { kind: "missing" } as const;
    const product = await db.product.findFirst({
      where: { id: productId, active: true, publication: { not: "ARCHIVED" },
        ...(scope.shopId && { marketplaceShopId: scope.shopId }),
        OR: [
          { sellerListingReviews: { some: { marketId, state: { not: "WITHDRAWN" } } } },
          { variants: { some: { archivedAt: null, offers: { some: { marketId,
            ...(scope.shopId && { OR: [{ offerId: null }, { identity: { is: { sellerId: scope.shopId, retiredAt: null } } }] }),
          } } } } },
        ],
      },
      select: { name: true, brand: true, revision: true },
    });
    if (!product) return { kind: "missing" } as const;

    // The fixture emits one structured response and never contacts a provider.
    const name = product.name.replace(/[<>\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    const brand = product.brand?.replace(/[<>\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 70);
    const text = [name, brand && `Brand: ${brand}`].filter(Boolean).join(" · ");
    const draft = mode === "timeout" || !name ? null : plainCopy.safeParse(mode === "invalid" ? "<invalid fixture>" :
      purpose === "summary" ? `Product: ${text}.` :
      `${text}. Review the specification and variant details before completing this description.`);
    const body = draft?.success ? draft.data : null;
    await db.catalogCopySuggestion.createMany({ skipDuplicates: true, data: [{
      ...scope, operationId, productId, purpose, state: body ? "SAVED" : "UNAVAILABLE", body, productRevision: product.revision,
    }] });
    const saved = await db.catalogCopySuggestion.findFirst({
      where: { ...scope, operationId, productId, purpose, productRevision: product.revision }, select: details,
    });
    return saved ? { kind: "recorded", record: saved } as const : { kind: "conflict" } as const;
  });
}
