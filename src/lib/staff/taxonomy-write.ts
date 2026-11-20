import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { authorize } from "./operations.ts";
import { CatalogWriteError } from "./operation-error.ts";

export async function lockTaxonomy(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(3100, 8)`;
}

export async function authorizeTaxonomyMarket(tx: Prisma.TransactionClient, actorId: string, marketId: MarketId) {
  if (!isMarketSelectable(marketId)) throw new CatalogWriteError("forbidden", "Choose an available market.");
  await tx.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actorId} FOR SHARE`;
  const staff = await authorize(tx, actorId);
  if (staff.role === "OWNER") return staff;
  const [grant] = await tx.$queryRaw<{ merchandising: boolean }[]>`
    SELECT merchandising FROM "StaffMarketAccess"
    WHERE "userId" = ${actorId} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE
  `;
  if (!grant?.merchandising) throw new CatalogWriteError("forbidden", "Merchandising permission is required for this market.");
  return staff;
}

export function categoryPlacementScope(ids: string[], allowLegacy: boolean): Prisma.DepartmentWhereInput {
  const typed: Prisma.DepartmentWhereInput = {
    kind: "SUBCATEGORY", parent: {
      is: { kind: "CATEGORY", state: "ACTIVE", parent: { is: { kind: "DEPARTMENT", state: "ACTIVE", parentId: null } } },
    },
  };
  return { id: { in: ids }, state: "ACTIVE", ...(allowLegacy ? { OR: [typed, { kind: null }] } : typed) };
}

export async function validPrimaryCategory(db: DbReader, id: string, productId: string) {
  return Boolean(await db.department.findFirst({
    where: { ...categoryPlacementScope([id], true), secondaryProducts: { none: { productId } } },
    select: { id: true },
  }));
}
