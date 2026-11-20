import type { MarketId } from "../../config/markets.ts";
import type { DbReader } from "../db/client.ts";
import { catalogBrowseHref, catalogProductHref } from "./category-browse-links.ts";
import { catalogVariantWhere } from "./connected-public.ts";
import { stockedDepartments } from "./departments.ts";
import type { HomepageTile } from "./homepage-contract.ts";
import type { ProductCardData } from "./listing.ts";
import type { CatalogImage, Collection, Department } from "./types.ts";

type HomepageDepartment = Department & { visibleInNavigation: boolean };

export type ResolvedHomepageTile = {
  id: string;
  kind: HomepageTile["kind"];
  title: string;
  ctaLabel: string;
  href: string;
  image: CatalogImage;
  mobileImage?: CatalogImage;
  focalPoint?: HomepageTile["focalPoint"];
  mobileFocalPoint?: HomepageTile["mobileFocalPoint"];
  product?: { id: string; variantId: string; amountMinor: number; regularMinor: number; promotionEndsAt: string | null };
};

export async function homepageTileDestinations(db: DbReader, marketId: MarketId, tiles: readonly HomepageTile[],
  departments: readonly HomepageDepartment[], collections: readonly Collection[]) {
  const categoryIds = new Set(tiles.filter(tile => tile.kind === "CATEGORY").map(tile => tile.referenceId));
  const collectionIds = new Set(tiles.filter(tile => tile.kind === "COLLECTION").map(tile => tile.referenceId));
  const selectedCollections = collections.filter(collection => collectionIds.has(collection.id));
  const curatedIds = selectedCollections.filter(collection => !collection.selection).map(collection => collection.id);
  const marketProduct = { variants: { some: catalogVariantWhere(marketId) } };
  const [occupied, curated, newest, featured] = await Promise.all([
    categoryIds.size ? db.department.findMany({
      where: { id: { in: departments.map(department => department.id) }, OR: [
        { products: { some: marketProduct } },
        { secondaryProducts: { some: { product: marketProduct } } },
      ] },
      select: { id: true },
    }) : [],
    curatedIds.length ? db.collectionProduct.findMany({
      where: { collectionId: { in: curatedIds }, product: marketProduct }, distinct: ["collectionId"], select: { collectionId: true },
    }) : [],
    selectedCollections.some(collection => collection.selection === "new")
      ? db.product.findFirst({ where: { ...marketProduct, newArrival: true }, select: { id: true } }) : null,
    selectedCollections.some(collection => collection.selection === "featured")
      ? db.product.findFirst({ where: { ...marketProduct, featured: true }, select: { id: true } }) : null,
  ]);
  const browsable = stockedDepartments(departments, occupied.map(department => department.id));
  const availableDepartments = new Set(browsable.map(department => department.id));
  const memberIds = new Set(curated.map(member => member.collectionId));
  return {
    categories: new Map(departments.filter(department =>
      categoryIds.has(department.id) && department.visibleInNavigation && availableDepartments.has(department.id))
      .map(department => [department.id, department])),
    collections: new Map(selectedCollections.filter(collection =>
      collection.selection === "new" ? newest : collection.selection === "featured" ? featured : memberIds.has(collection.id))
      .map(collection => [collection.id, collection])),
  };
}

const defaultCta: Record<HomepageTile["kind"], string> = {
  CATEGORY: "View all", COLLECTION: "Shop collection", PRODUCT: "Shop product",
};

export function resolveHomepageTiles(tiles: readonly HomepageTile[], destinations: Awaited<ReturnType<typeof homepageTileDestinations>>,
  products: ReadonlyMap<string, ProductCardData>, displayed: Set<string>, context: Parameters<typeof catalogBrowseHref>[1],
  resolveImage: (image?: CatalogImage) => CatalogImage | undefined): ResolvedHomepageTile[] {
  return tiles.flatMap(tile => {
    const product = tile.kind === "PRODUCT" && !displayed.has(tile.referenceId) ? products.get(tile.referenceId) : undefined;
    const destination = tile.kind === "CATEGORY" ? destinations.categories.get(tile.referenceId)
      : tile.kind === "COLLECTION" ? destinations.collections.get(tile.referenceId) : product;
    if (!destination) return [];
    const desktop = resolveImage(tile.image);
    const mobile = resolveImage(tile.mobileImage);
    const image = desktop ?? destination.image;
    if (!image) return [];
    const group = tile.kind === "CATEGORY" ? "departments" : "collections";
    const href = product
      ? catalogProductHref({ slug: product.slug, matchedVariantId: product.variantId, knownOptions: [] }, context)
      : catalogBrowseHref(`/${group}/${encodeURIComponent(destination.slug)}`, context);
    if (product) displayed.add(product.id);
    return [{ id: tile.key, kind: tile.kind, title: tile.title ?? destination.name, ctaLabel: tile.ctaLabel ?? defaultCta[tile.kind], href, image,
      ...(mobile && { mobileImage: mobile }),
      ...((!tile.image || desktop) && tile.focalPoint && { focalPoint: tile.focalPoint }),
      ...((!tile.mobileImage || mobile) && tile.mobileFocalPoint && { mobileFocalPoint: tile.mobileFocalPoint }),
      ...(product && { product: { id: product.id, variantId: product.variantId, amountMinor: product.priceMinor,
        regularMinor: product.regularMinor ?? product.priceMinor, promotionEndsAt: product.promotion?.endsAt ?? null } }),
    }];
  });
}
