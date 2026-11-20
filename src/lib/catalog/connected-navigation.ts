import type { MarketId } from "../../config/markets.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { hybridDemoMode } from "../release-config.ts";
import { categoryAttributes } from "./category-attributes.ts";
import { catalogBrowseHref } from "./category-browse-links.ts";
import { listCategoryPresentation, resolveCategoryReference, type CategoryPresentation } from "./category-presentation.ts";
import { publicCollectionScope } from "./collection-selection.ts";
import { catalogVariantWhere } from "./connected-public.ts";
import { departmentAncestorPath, departmentFamily, departmentTree } from "./departments.ts";
import { heroPhoto } from "./imagery.ts";
import { readMarketMenu } from "./navigation.ts";
import { availableMarketEditorialMedia, marketEditorialImage } from "./repository.ts";

export { connectedCollectionProductFilter } from "./collection-selection.ts";

type NavigationContext = { marketId: MarketId; locale: string };

async function publicCategoryImages(categories: readonly CategoryPresentation[], marketId: MarketId, db: DbReader) {
  const available = await availableMarketEditorialMedia(categories.flatMap(({ image, banner }) => banner ? [image.src, banner.src] : [image.src]), marketId, db);
  return categories.map(category => ({ ...category, image: marketEditorialImage(category.image, available, marketId) ?? heroPhoto,
    banner: category.banner ? marketEditorialImage(category.banner, available, marketId) ?? null : null }));
}

export async function resolveConnectedCategory(ref: string, marketId: MarketId, locale: string, db: DbReader = getDb()) {
  if (!ref.trim() || ref.length > 120) return null;
  const categories = await listCategoryPresentation(marketId, locale, db);
  const byId = new Map(categories.map(category => [category.id, category]));
  const exact = byId.get(ref);
  const resolved = exact ? { category: exact, redirectSlug: null } : await resolveCategoryReference(ref, marketId, locale, db, categories);
  if (!resolved) return null;
  const path = departmentAncestorPath(byId, resolved.category.id);
  if (!path) return null;
  const family = departmentFamily(categories, resolved.category.id);
  return { ...resolved, ancestors: path.slice(0, -1), descendants: categories.filter(category => family.has(category.id)) };
}

function listingPath(context: NavigationContext, key: "category" | "collection", id: string) {
  return storefrontPath(`/api/catalog/products?${new URLSearchParams({ market: context.marketId, lang: context.locale, [key]: id })}`);
}

export async function connectedCategoryTree(context: NavigationContext, db: DbReader = getDb()) {
  const { marketId, locale } = context;
  const categories = await listCategoryPresentation(marketId, locale, db);
  return { marketId, locale, categories: departmentTree(await publicCategoryImages(categories, marketId, db)) };
}

export async function connectedCategoryDetail(ref: string, context: NavigationContext, db: DbReader = getDb()) {
  const { marketId, locale } = context;
  const resolved = await resolveConnectedCategory(ref, marketId, locale, db);
  if (!resolved) return null;
  const { category, ancestors, descendants, redirectSlug } = resolved;
  const children = descendants.filter(row => row.parentId === category.id);
  const [[publicCategory, ...related], attributes] = await Promise.all([
    publicCategoryImages([category, ...ancestors, ...children], marketId, db),
    categoryAttributes(category.id, db),
  ]);
  return { marketId, locale, category: publicCategory, redirectSlug,
    ancestors: related.slice(0, ancestors.length), children: related.slice(ancestors.length),
    descendantCategoryIds: descendants.map(row => row.id).filter(id => id !== category.id), attributes,
    productsHref: listingPath(context, "category", category.id) };
}

const collectionFields = {
  id: true, slug: true, name: true, description: true, selection: true, position: true, imageSrc: true, imageAlt: true,
} as const;

export async function resolveConnectedCollection(ref: string, db: DbReader = getDb(), marketId?: MarketId) {
  const slug = ref.trim().toLowerCase();
  if (!slug || slug.length > 120) return null;
  const scope = publicCollectionScope(marketId);
  const exact = await db.collection.findFirst({ where: { id: ref, ...scope }, select: collectionFields });
  return exact ?? db.collection.findFirst({ where: { slug, ...scope }, select: collectionFields });
}

type PublicCollection = NonNullable<Awaited<ReturnType<typeof resolveConnectedCollection>>>;

async function publicCollections(rows: readonly PublicCollection[], context: NavigationContext, db: DbReader) {
  const available = await availableMarketEditorialMedia(rows.flatMap(row => row.imageSrc ?? []), context.marketId, db);
  return rows.map(({ imageSrc, imageAlt, ...row }) => ({ ...row, image: imageSrc && imageAlt
    ? marketEditorialImage({ src: imageSrc, alt: imageAlt }, available, context.marketId) ?? heroPhoto : null,
  productsHref: listingPath(context, "collection", row.id) }));
}

export async function connectedCollections(context: NavigationContext, db: DbReader = getDb()) {
  const rows = await db.collection.findMany({ where: publicCollectionScope(context.marketId), select: collectionFields,
    orderBy: [{ position: "asc" }, { id: "asc" }] });
  return { marketId: context.marketId, locale: context.locale, collections: await publicCollections(rows, context, db) };
}

export async function connectedCollectionDetail(ref: string, context: NavigationContext, db: DbReader = getDb()) {
  const row = await resolveConnectedCollection(ref, db, context.marketId);
  if (!row) return null;
  const [collection] = await publicCollections([row], context, db);
  return { marketId: context.marketId, locale: context.locale, collection };
}

export async function connectedCategoryCollections(ids: string[], context: NavigationContext, db: DbReader = getDb()) {
  const inCategory = {
    OR: [{ departmentId: { in: ids } }, { secondaryCategories: { some: { departmentId: { in: ids } } } }],
    variants: { some: catalogVariantWhere(context.marketId) },
  } satisfies Prisma.ProductWhereInput;
  const [newArrival, featured] = await Promise.all([
    db.product.findFirst({ where: { ...inCategory, newArrival: true }, select: { id: true } }),
    db.product.findFirst({ where: { ...inCategory, featured: true }, select: { id: true } }),
  ]);
  const rows = await db.collection.findMany({
    where: { AND: [publicCollectionScope(context.marketId), { OR: [
      { selection: "CURATED", products: { some: { product: inCategory } } },
      ...(newArrival ? [{ selection: "NEW" as const }] : []),
      ...(featured ? [{ selection: "FEATURED" as const }] : []),
    ] }] },
    select: collectionFields, orderBy: [{ position: "asc" }, { id: "asc" }], take: 4,
  });
  return publicCollections(rows, context, db);
}

export async function connectedMarketMenu(key: string, context: NavigationContext, db: DbReader = getDb()) {
  const { marketId, locale } = context;
  const menu = await readMarketMenu(marketId, key, locale, db);
  if (!menu) return null;
  const route = { id: marketId, locale, regional: hybridDemoMode() };
  return { marketId, locale, key, ...menu, items: menu.items.map(item => ({
    ...item, href: storefrontPath(catalogBrowseHref(item.href, route)),
  })) };
}
