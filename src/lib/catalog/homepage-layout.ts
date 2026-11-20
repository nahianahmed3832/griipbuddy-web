import { storefrontPath } from "../../config/storefront-path.ts";
import { getDb } from "../db/client.ts";
import { reportFailure } from "../db/observability.ts";
import type { MarketConfiguration } from "../market-config.ts";
import { hybridDemoMode } from "../release-config.ts";
import { marketHasDelivery } from "../commerce/orders.ts";
import { activeHomepageSections, homepageTileImages, type HomepageSection, type HomepageTileLayout } from "./homepage-contract.ts";
import { homepageMediaSources, homepageTileUploadSources, publishedHomepage } from "./homepage-content.ts";
import { homepageTileDestinations, resolveHomepageTiles, type ResolvedHomepageTile } from "./homepage-tiles.ts";
import { recommendationConfig } from "./recommendation-config.ts";
import { loadRecommendations } from "./recommendations.ts";
import { newestFirst, productCards, type ProductCardData } from "./listing.ts";
import { departmentFamily, stockedDepartments, type DepartmentNode } from "./departments.ts";
import { availableMarketEditorialMedia, catalog, marketEditorialImage } from "./repository.ts";
import { resolveCategorySlug, type CategoryPresentation } from "./category-presentation.ts";
import { connectedCategoryTree } from "./connected-navigation.ts";
import { catalogBrowseHref, catalogProductHref } from "./category-browse-links.ts";
import { orderedCollectionProducts } from "./collection-selection.ts";
import { homepageProducts } from "./homepage-products.ts";
import { eligibleHomeProducts, homepageDealCards } from "./homepage-offers.ts";
import type { CatalogImage, Collection, Department } from "./types.ts";

export { visibleHomepageSection } from "./homepage-contract.ts";
export { eligibleHomeProducts } from "./homepage-offers.ts";
export type { ResolvedHomepageTile } from "./homepage-tiles.ts";

type Panel = {
  section: HomepageSection;
  cards?: readonly ProductCardData[];
  departments?: readonly Department[];
  collections?: readonly Collection[];
  spotlight?: Department;
  tileLayout?: HomepageTileLayout;
  tiles?: readonly ResolvedHomepageTile[];
  recommendations?: readonly { card: ProductCardData; departmentId: string; similarEligible?: boolean }[];
  evidenceFallback?: boolean;
  recommendationVersion?: string;
};

function flatCategories(nodes: readonly DepartmentNode<CategoryPresentation>[]): CategoryPresentation[] {
  return nodes.flatMap(node => {
    const { children, ...category } = node;
    return [category, ...flatCategories(children)];
  });
}

type HomepageLayoutOptions = { previewScopeKey?: string; at?: Date; personalized?: boolean; editorialOnly?: boolean };

export async function homepageLayout(market: MarketConfiguration, options: HomepageLayoutOptions) {
  const at = options.at ?? new Date();
  const db = getDb();
  const { id: marketId, locale } = market;
  const navigation = { marketId, locale };
  const context = { id: marketId, locale, regional: hybridDemoMode() };
  const [config, ranking, marketCoverage] = await Promise.all([
    publishedHomepage(marketId, locale, options.previewScopeKey),
    recommendationConfig(marketId, locale, options.previewScopeKey),
    marketHasDelivery(marketId),
  ]);
  const active = activeHomepageSections(config.layers, at, market.timeZone);
  const catalogTiles = active.flatMap(section => section.tiles ?? []);
  const tileImageSources = active.flatMap(section => homepageTileImages(section).map(image => image.src));
  const bannerImageSources = active.flatMap(section => section.type === "TILES" ? [] : section.bannerImage?.src ?? []);
  const needsCategories = catalogTiles.some(tile => tile.kind === "CATEGORY") ||
    active.some(section => section.type === "DEPARTMENTS" || section.type === "CATEGORY_SPOTLIGHT" ||
    section.link?.href.startsWith("/departments/"));
  const needsCollections = catalogTiles.some(tile => tile.kind === "COLLECTION") ||
    active.some(section => section.type === "COLLECTIONS" || section.type === "COLLECTION" ||
    section.link?.href.startsWith("/collections/"));
  const [products, tree, collections, catalogMedia, homepageMedia, tileUploads] = await Promise.all([
    marketCoverage ? homepageProducts(db, market, at) : [],
    needsCategories ? connectedCategoryTree(navigation, db) : null,
    needsCollections ? catalog.listCollections(marketId) : [],
    availableMarketEditorialMedia([...bannerImageSources, ...tileImageSources], marketId, db),
    homepageMediaSources(bannerImageSources, db),
    homepageTileUploadSources(tileImageSources, marketId, locale, db),
  ]);
  const departments = tree ? flatCategories(tree.categories) : [];
  const departmentById = new Map(departments.map(category => [category.id, category]));
  const departmentViews = departments.map(category => ({ ...category, slug: category.localizedSlug, parentId: category.parentId ?? undefined }));
  const departmentViewById = new Map(departmentViews.map(category => [category.id, category]));
  const collectionById = new Map(collections.map(collection => [collection.id, collection]));
  const collectionBySlug = new Map(collections.map(collection => [collection.slug, collection]));
  const eligible = eligibleHomeProducts(products, market);
  const cards = productCards(eligible);
  const cardsById = new Map(cards.map(card => [card.id, card]));
  const productById = new Map(eligible.map(product => [product.id, product]));
  const collectionIds = collections.filter(collection => !collection.selection).map(collection => collection.id);
  const [members, tileDestinations] = await Promise.all([
    collectionIds.length && cards.length ? db.collectionProduct.findMany({
      where: { collectionId: { in: collectionIds }, productId: { in: cards.map(card => card.id) } },
      select: { collectionId: true, productId: true }, orderBy: orderedCollectionProducts,
    }) : [],
    catalogTiles.length ? homepageTileDestinations(db, marketId, catalogTiles, departmentViews, collections) : null,
  ]);
  const cardsByCollection = new Map<string, ProductCardData[]>();
  for (const { collectionId, productId } of members) {
    const group = cardsByCollection.get(collectionId) ?? [];
    group.push(cardsById.get(productId)!);
    cardsByCollection.set(collectionId, group);
  }
  const newCards = productCards(eligible.filter(product => product.newArrival).sort(newestFirst));
  const featured = productCards(eligible.filter(product => product.featured));
  const stocked = stockedDepartments(departmentViews, eligible.flatMap(product => product.categoryIds))
    .filter(department => departmentViewById.get(department.id)?.visibleInNavigation);
  const stockedById = new Map(stocked.map(department => [department.id, department]));
  const roots = stocked.filter(department => !department.parentId);
  const soldDepartments = roots.length === 1 && stocked.length > 1 ? stocked.filter(department => department.parentId === roots[0].id) : roots;
  for (const collection of collections) {
    if (collection.selection === "new") cardsByCollection.set(collection.id, newCards);
    if (collection.selection === "featured") cardsByCollection.set(collection.id, featured);
  }
  const carry = collections.find(collection => collection.slug === "everyday-carry" && cardsByCollection.get(collection.id)?.length);
  const byId = (ids: readonly string[] = []) => ids.flatMap(id => cardsById.get(id) ?? []);
  const productSlugs = new Set(eligible.map(product => product.slug));
  const categoryLinks = new Map(await Promise.all([...new Set(active.flatMap(section =>
    section.link?.href.startsWith("/departments/") ? [section.link.href.slice("/departments/".length)] : []))]
    .map(async slug => [slug, await resolveCategorySlug(slug, marketId, locale, db, departments)] as const)));
  const similar = cards.map(card => ({ card, departmentId: productById.get(card.id)!.departmentId }));
  const displayed = new Set<string>();
  const panels: Panel[] = [];
  const editorialImage = (uploads: ReadonlySet<string>, image?: CatalogImage) => image && (uploads.has(image.src)
    ? { ...image, src: `${image.src}?${new URLSearchParams({ market: marketId, lang: locale })}` }
    : marketEditorialImage(image, catalogMedia, marketId));
  for (const configured of active) {
    if (options.editorialOnly && (["BESTSELLERS", "TRENDING", "RECENTLY_VIEWED", "RELATED"] as const)
      .some(type => configured.type === type)) continue;
    const bannerImage = editorialImage(configured.type === "TILES" ? tileUploads : homepageMedia, configured.bannerImage);
    const section = { ...configured, bannerImage, link: undefined as HomepageSection["link"] };
    if (configured.link) {
      const { href, label } = configured.link;
      const [, group, slug] = href.split("/");
      const category = group === "departments" && categoryLinks.get(slug)?.category;
      if (category) section.link = { label, href: catalogBrowseHref(`/departments/${encodeURIComponent(category.localizedSlug)}`, context) };
      if (group === "collections" && collectionBySlug.has(slug) || group === "products" && productSlugs.has(slug) || group === "shop" || group === "gifts") {
        section.link = { label, href: catalogBrowseHref(href, context) };
      }
    }
    if (section.type === "BENEFITS") {
      if (section.benefits?.length) panels.push({ section });
      continue;
    }
    if (section.type === "BANNER" && section.key !== "hero" && !section.bannerImage) continue;
    if (section.type === "TILES") {
      if (!tileDestinations || !section.tileLayout || !section.tiles) continue;
      const tiles = resolveHomepageTiles(section.tiles, tileDestinations, cardsById, displayed, context,
        asset => editorialImage(tileUploads, asset));
      if (tiles.length) panels.push({ section, tileLayout: section.tileLayout, tiles });
      continue;
    }
    const rowLimit = section.type === "BANNER" ? Math.min(section.limit ?? 2, 2) : section.limit ?? 6;
    if (section.type === "DEPARTMENTS") {
      const selected = section.categoryIds?.length ? section.categoryIds.flatMap(id => stockedById.get(id) ?? []) : soldDepartments;
      if (selected.length) panels.push({ section, departments: selected.slice(0, rowLimit) });
      continue;
    }
    if (section.type === "COLLECTIONS") {
      const selected = section.collectionIds?.length ? section.collectionIds.flatMap(id => collectionById.get(id) ?? []) : collections;
      const curated = selected.filter(collection => collection.image && cardsByCollection.get(collection.id)?.length);
      if (curated.length) panels.push({ section, collections: curated.slice(0, rowLimit) });
      continue;
    }
    if (section.type === "RECENTLY_VIEWED") {
      if (marketCoverage && ranking.behavioralEnabled && ranking.placements.continue.enabled) panels.push({ section });
      continue;
    }
    if (section.type === "RELATED") {
      if (options.personalized && ranking.behavioralEnabled && ranking.placements.similar.enabled && similar.length) {
        panels.push({ section, recommendations: similar });
      }
      continue;
    }
    let candidates: readonly ProductCardData[] = [];
    let evidenceFallback = false;
    let recommendationVersion: string | undefined;
    if (section.type === "BANNER") candidates = byId(section.productIds);
    if (section.type === "CURATED") candidates = byId(section.productIds);
    if (section.type === "NEW") candidates = newCards;
    if (section.type === "FEATURED") candidates = section.productIds?.length ? byId(section.productIds) : featured;
    if (section.type === "DEALS") candidates = homepageDealCards(eligible, market.currency, section.budget);
    const spot = section.categoryId && departmentById.get(section.categoryId);
    const spotlight = spot && spot.visibleInNavigation && departmentViewById.get(spot.id) || undefined;
    if (section.type === "CATEGORY_SPOTLIGHT") {
      if (!spotlight || !spot) continue;
      const descendants = departmentFamily(departments, spot.id);
      candidates = eligible.filter(product => product.categoryIds.some(id => descendants.has(id)))
        .flatMap(product => cardsById.get(product.id) ?? []);
      section.bannerImage ??= spot.banner ?? spot.image;
      section.link = { label: section.link?.label ?? "Shop category",
        href: catalogBrowseHref(`/departments/${encodeURIComponent(spot.localizedSlug)}`, context) };
    }
    if (section.type === "COLLECTION") {
      const collection = section.collection && collectionBySlug.get(section.collection);
      if (collection) {
        candidates = cardsByCollection.get(collection.id) ?? [];
        section.link ??= { label: collection.name, href: catalogBrowseHref(`/collections/${encodeURIComponent(collection.slug)}`, context) };
      }
    }
    if (section.type === "BESTSELLERS" || section.type === "TRENDING") {
      const placement = section.type === "BESTSELLERS" ? "bestsellers" : "trending";
      const policy = ranking.placements[placement];
      if (!marketCoverage || !policy.enabled) continue;
      const fallback = policy.fallbackConfigured ? policy.fallback : section.fallbackIds ?? [];
      const recommendation = await loadRecommendations({ marketId: market.id, locale: market.locale, placement,
        config: { ...ranking, placements: { ...ranking.placements, [placement]: { ...policy,
          fallback,
        } } }, allowBehavioral: false, excludeProductIds: [...displayed], limit: rowLimit, asOf: at }).catch(error => {
        reportFailure("catalog.homepage-demand", undefined, error);
        return null;
      });
      const expectedReason = placement === "bestsellers" ? "market-bestseller" : "market-trending";
      const supported = recommendation?.items.filter(item => item.reason === expectedReason) ?? [];
      evidenceFallback = supported.length < 2;
      recommendationVersion = recommendation?.version;
      candidates = recommendation ? byId((evidenceFallback ? recommendation.items : supported).map(item => item.productId))
        : byId(fallback.filter(id => !policy.excludes.includes(id)));
    }
    if (!candidates.length && (section.type === "CURATED" || section.type === "FEATURED" || section.type === "NEW")) {
      candidates = byId(section.fallbackIds);
    }
    const row: ProductCardData[] = [];
    for (const card of candidates) {
      if (displayed.has(card.id)) continue;
      row.push(card);
      displayed.add(card.id);
      if (row.length === rowLimit) break;
    }
    if (section.type === "BANNER" || row.length) panels.push({ section, cards: row, spotlight, evidenceFallback, recommendationVersion });
  }
  return {
    panels: panels.map(panel => ({
      ...panel, recommendations: panel.recommendations?.map(row => ({ ...row, similarEligible: !displayed.has(row.card.id) })),
    })),
    measurement: config.measurement, carry, ranking, marketCoverage,
  };
}

export async function homepageReadPayload(market: MarketConfiguration, options: Pick<HomepageLayoutOptions, "at" | "previewScopeKey"> = {}) {
  const { panels, measurement } = await homepageLayout(market, { ...options, editorialOnly: true });
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const image = (asset: CatalogImage) => ({ ...asset, src: storefrontPath(asset.src) });
  const category = ({ id, slug, name, image: asset }: Department) => ({
    id, slug, name, image: image(asset), href: storefrontPath(catalogBrowseHref(`/departments/${encodeURIComponent(slug)}`, context)),
  });
  return {
    marketId: market.id, locale: market.locale, currency: market.currency, homepageConfig: measurement,
    sections: panels.filter(({ section }) => section.key !== "hero").map(({ section, cards, departments, collections, spotlight, tileLayout, tiles }) => ({
      id: section.key, type: section.type, benefits: section.benefits, title: section.title, description: section.description ?? null, position: section.position,
      enabled: true as const, image: section.bannerImage ? image(section.bannerImage) : null,
      destination: section.link ? { ...section.link, href: storefrontPath(section.link.href) } : null,
      startsLocal: section.startsLocal ?? null, endsLocal: section.endsLocal ?? null,
      products: (cards ?? []).map(card => ({
        id: card.id, slug: card.slug, name: card.name, variantId: card.variantId, image: image(card.image),
        href: storefrontPath(catalogProductHref({ slug: card.slug, matchedVariantId: card.variantId, knownOptions: [] }, context)),
        amountMinor: card.priceMinor, regularMinor: card.regularMinor ?? card.priceMinor, promotionEndsAt: card.promotion?.endsAt ?? null,
      })),
      categories: (departments ?? (spotlight ? [spotlight] : [])).map(category),
      collections: (collections ?? []).map(({ id, slug, name, description, image: asset }) => ({
        id, slug, name, description, image: asset ? image(asset) : null,
        href: storefrontPath(catalogBrowseHref(`/collections/${encodeURIComponent(slug)}`, context)),
      })),
      ...(tileLayout && tiles && { tileLayout, tiles: tiles.map(tile => ({
        ...tile, href: storefrontPath(tile.href), image: image(tile.image),
        ...(tile.mobileImage && { mobileImage: image(tile.mobileImage) }),
      })) }),
    })),
  };
}
