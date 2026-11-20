import type { MarketId } from "../../config/markets.ts";
import type { Prisma, PublicationState } from "../../generated/prisma/client.ts";
import { categoryAttributesForMany, type EffectiveCategoryAttribute } from "../catalog/category-attributes.ts";
import { catalogVariantWhere } from "../catalog/connected-public.ts";
import { departmentAncestorPath } from "../catalog/departments.ts";
import { getDb } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { staffMarketIds } from "./market-access.ts";
import { authorize } from "./operations.ts";
import type { ownerProductFoundation } from "./product-foundation.ts";
import { legacyProductScope } from "../catalog/scoped-pilot.ts";
import { productPublicationReadiness } from "./product-publication.ts";
import { categoryPlacementScope } from "./taxonomy-write.ts";

export type ProductWorkspaceProduct = NonNullable<Awaited<ReturnType<typeof ownerProductFoundation>>>;
export type ProductCategoryAttribute = EffectiveCategoryAttribute & { sourceName: string };
export type ProductCategoryChoice = { id: string; label: string; templates: ProductCategoryAttribute[] };

const rowsPerPage = 18;

export async function productWorkspaceAccess(actorId: string) {
  const [actor, grants] = await Promise.all([authorize(getDb(), actorId), staffMarketIds(actorId, "commercial")]);
  return { owner: actor.role === "OWNER", marketIds: grants.filter(isMarketSelectable) };
}

function permittedProduct(owner: boolean, marketIds: readonly MarketId[]): Prisma.ProductWhereInput {
  if (owner) return {};
  return { foundation: true, OR: [
    { variants: { some: { offers: { some: { marketId: { in: [...marketIds] } } } } } },
    { active: true, publication: "ACTIVE" },
  ] };
}

export async function productWorkspaceIdentity(actorId: string, id: string) {
  const access = await productWorkspaceAccess(actorId);
  if (!access.owner && !access.marketIds.length) return null;
  const product = await getDb().product.findFirst({
    where: { id, ...permittedProduct(access.owner, access.marketIds) },
    select: { id: true, name: true, description: true, slug: true, foundation: true, publication: true, department: { select: { name: true } } },
  });
  return product && { product, ...access };
}

type ProductFilters = {
  q?: string; state?: PublicationState; source?: "connected" | "legacy"; market?: MarketId; page: number;
  excludeRedirected?: boolean;
  legacyPilot?: boolean;
};

export async function listProductWorkspace(actorId: string, filters: ProductFilters) {
  const access = await productWorkspaceAccess(actorId);
  if (!access.owner && !access.marketIds.length) return null;
  const db = getDb();
  const { q, state, source, market, page, excludeRedirected, legacyPilot } = filters;
  const contains = q && { contains: q, mode: "insensitive" as const };
  const where: Prisma.ProductWhereInput = { AND: [
    permittedProduct(access.owner, access.marketIds),
    ...(legacyPilot ? [await legacyProductScope(db)] : []),
    { ...(state && { publication: state }), ...(source && { foundation: source === "connected" }),
      ...(excludeRedirected && { migratedFromSlug: null }) },
    ...(contains ? [{ OR: [{ name: contains }, { id: contains }, { brand: contains }, { variants: { some: { sku: contains } } }] }] : []),
    ...(market ? [{ variants: { some: { offers: { some: { marketId: access.marketIds.includes(market) ? market : { in: [] } } } } } }] : []),
  ] };
  const rows = await db.product.findMany({
    where, orderBy: [{ addedOn: "desc" }, { id: "asc" }], skip: (page - 1) * rowsPerPage, take: rowsPerPage + 1,
    select: { id: true, name: true, publication: true, foundation: true, active: true, demo: true,
      department: { select: { name: true } }, _count: { select: { variants: true } },
    },
  });
  const visible = rows.slice(0, rowsPerPage);
  const activeIds = visible.filter(row => row.active && row.publication === "ACTIVE").map(row => row.id);
  const publishedMarkets = activeIds.length ? await Promise.all(access.marketIds.map(async marketId => {
    const products = await db.product.findMany({
      where: { id: { in: activeIds }, variants: { some: catalogVariantWhere(marketId) } }, select: { id: true },
    });
    return { marketId, ids: new Set(products.map(product => product.id)) };
  })) : [];
  const details = [];
  // Limit in-flight readers against the shared Prisma pool.
  for (let index = 0; index < visible.length; index += 4) {
    details.push(...await Promise.all(visible.slice(index, index + 4).map(async row => ({
      id: row.id, name: row.name, publication: row.publication, active: row.active, foundation: row.foundation, demo: row.demo,
      category: row.department.name, variants: row._count.variants,
      markets: publishedMarkets.filter(market => market.ids.has(row.id)).map(market => market.marketId),
      incomplete: access.owner && row.foundation && (await productPublicationReadiness(db, row.id))?.ready === false,
    }))));
  }
  return { ...access, rows: details, hasNext: rows.length > rowsPerPage };
}

export async function productCategoryChoices(actorId: string): Promise<ProductCategoryChoice[]> {
  const db = getDb();
  await authorize(db, actorId, true);
  const nodes = await db.department.findMany({
    where: { state: "ACTIVE" }, orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, parentId: true, name: true, kind: true },
  });
  const byId = new Map(nodes.map(row => [row.id, row]));
  const leafIds = nodes.filter(row => row.kind === "SUBCATEGORY").map(row => row.id);
  const usable = await db.department.findMany({ where: categoryPlacementScope(leafIds, false), select: { id: true } });
  const templates = await categoryAttributesForMany(usable.map(row => row.id), db);
  return usable.flatMap(({ id }) => {
    const path = departmentAncestorPath(byId, id);
    const fields = (templates.get(id) ?? []).map(template => ({
      ...template, sourceName: byId.get(template.sourceDepartmentId)?.name ?? template.sourceDepartmentId,
    }));
    return path ? [{ id, label: path.map(row => row.name).join(" / "), templates: fields }] : [];
  }).sort((a, b) => a.label.localeCompare(b.label));
}

function readString(data: unknown, key: string) {
  return data && typeof data === "object" && key in data && typeof (data as Record<string, unknown>)[key] === "string"
    ? (data as Record<string, string>)[key] : undefined;
}

export async function productWorkspaceHistory(actorId: string, productId: string, variantIds: string[]) {
  const db = getDb();
  await authorize(db, actorId, true);
  const [rows, movements] = await Promise.all([
    db.auditEvent.findMany({
      where: { target: { in: [productId, ...variantIds] }, action: { in: ["PRODUCT_SAVED", "PRICE_CHANGED", "STOCK_CHANGED"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
      select: { id: true, createdAt: true, action: true, changes: true, actor: { select: { name: true } } },
    }),
    db.inventoryMovement.findMany({
      where: { pool: { variantId: { in: variantIds }, variant: { productId } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
      select: { id: true, kind: true, quantity: true, createdAt: true, actorId: true,
        pool: { select: { location: { select: { name: true } } } },
        allocation: { select: { reservation: { select: { marketId: true } } } } },
    }),
  ]);
  const staffIds = [...new Set(movements.flatMap(row => row.actorId ? [row.actorId] : []))];
  const staff = staffIds.length ? await db.user.findMany({
    where: { id: { in: staffIds }, staff: { isNot: null } }, select: { id: true, name: true },
  }) : [];
  const names = new Map(staff.map(row => [row.id, row.name]));
  const actions = rows.map(({ changes, actor, action, ...row }) => {
    const kind = readString(changes, "kind");
    const market = readString(changes, "marketId");
    const publication = kind === "publication" ? readString(changes, "after") : readString(changes, "publication");
    const label = action === "PRICE_CHANGED" ? "Market offer updated" : action === "STOCK_CHANGED" ? "Stock updated"
      : kind === "gallery" ? "Gallery updated" : kind === "translation" ? "Translation updated"
        : kind === "publication" ? "Product publication changed" : kind === "variant-compatibility" ? "Device compatibility updated" : "Product saved";
    const fields = changes && typeof changes === "object" && "changedFields" in changes && Array.isArray(changes.changedFields)
      ? changes.changedFields.filter(field => typeof field === "string").join(", ") : undefined;
    const changeActor = changes && typeof changes === "object" && "actor" in changes ? changes.actor : null;
    return { ...row, actorName: actor?.name ?? (readString(changeActor, "kind") === "seller" ? "Seller" : "Catalog operation"),
      label, market, publication, locale: readString(changes, "locale"), fields, warehouse: undefined, stock: action === "STOCK_CHANGED" };
  });
  const stock = movements.map(({ id, kind, quantity, createdAt, actorId, pool, allocation }) => ({
    id, createdAt, label: `Stock ${kind.toLowerCase().replaceAll("_", " ")} (${quantity > 0 ? "+" : ""}${quantity})`,
    actorName: actorId ? names.get(actorId) ?? "Inventory operator" : "Inventory ledger",
    market: allocation?.reservation.marketId, warehouse: pool.location.name, stock: true,
    publication: undefined, locale: undefined, fields: undefined,
  }));
  return [...actions, ...stock].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, 30);
}
