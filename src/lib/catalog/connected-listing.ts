import { markets } from "../../config/markets.ts";
import type { PrismaClient, Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { categoryAttributesForMany, type EffectiveCategoryAttribute } from "./category-attributes.ts";
import { browseCandidateFacets, browseFacetCounts, reconcileBrowseFacets } from "./category-browse-facets.ts";
import { listCategoryPresentation } from "./category-presentation.ts";
import { orderedCollectionProducts } from "./collection-selection.ts";
import { listingPage, listingScope, parseCatalogListing, type CatalogListingInput } from "./connected-listing-input.ts";
import { connectedCollectionProductFilter, resolveConnectedCategory, resolveConnectedCollection } from "./connected-navigation.ts";
import {
  CatalogApiError, catalogProduct, catalogVariantInclude, catalogVariantWhere, catalogVariants,
  type CatalogReadContext, type CatalogVariantRow,
} from "./connected-public.ts";
import { departmentAncestorPath } from "./departments.ts";
import { deviceLookupKey } from "./device-fitment.ts";
import {
  catalogSearchKey, catalogSearchMatcher, exactSearchIdentifierScore, exactSearchSkuScore, searchablePhrases, searchSpellingScore,
  searchSuggestionName, type CatalogSearchMatch, type SearchModel, type SearchOption,
} from "./search-match.ts";

const maxCandidates = 4_000;
const modelKeys = new Set(["model", "device", "device model", "phone model"]);
const designKeys = new Set(["design", "pattern", "style"]);
const colorKeys = new Set(["color", "colour"]);
const stableOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fold = (value: string) => value.normalize("NFKC").toLowerCase();
type PublicVariant = Awaited<ReturnType<typeof catalogVariants>>[number];
type PublicProduct = ReturnType<typeof catalogProduct>;
type AttributeValue = string | number | boolean;
type FacetValue = { value: string; label: string; matches: string[] };
type FacetKey = "brand" | "model" | "design" | "color" | "availability";
type Facets = Record<FacetKey, FacetValue[]>;
type Attribute = { definition: EffectiveCategoryAttribute; value: AttributeValue };
type Candidate = {
  variant: PublicVariant;
  score: number;
  searchMatch?: CatalogSearchMatch;
};
type Group = {
  product: PublicProduct;
  position: number;
  addedOn: Date;
  candidates: Candidate[];
};

function sameModel(a: string, b: string) {
  const model = catalogSearchKey(a);
  return model.length > 0 && model === catalogSearchKey(b);
}

function optionFacet(variant: PublicVariant, keys: ReadonlySet<string>): FacetValue[] {
  return variant.options.flatMap(option => keys.has(deviceLookupKey(option.key)) ? [{
    value: fold(option.value), label: option.valueLabel, matches: [option.value, option.valueLabel, option.valueId ?? ""],
  }] : []);
}

type ApprovedModel = PublicVariant["compatibility"][number];
type ModelIndex = Map<string, Map<string, ApprovedModel>>;

function indexModels(models: readonly ApprovedModel[]): ModelIndex {
  const index: ModelIndex = new Map();
  for (const model of models) for (const term of modelSearchTerms(model).names) {
    const key = catalogSearchKey(term);
    const identities = index.get(key) ?? new Map<string, ApprovedModel>();
    identities.set(model.id, model);
    index.set(key, identities);
  }
  return index;
}

function modelFacet(model: ApprovedModel): FacetValue {
  return { value: model.id, label: model.name, matches: [model.id, ...modelSearchTerms(model).names] };
}

function candidateFacets(brand: string | null | undefined, variant: PublicVariant, index?: ModelIndex): Facets {
  const compatible = variant.compatibility.map(modelFacet);
  const models = [...compatible];
  for (const option of optionFacet(variant, modelKeys)) {
    const linked = compatible.find(model => option.matches.some(value => model.matches.some(match => sameModel(value, match))));
    const identities = new Map(option.matches.flatMap(name => [...index?.get(catalogSearchKey(name)) ?? []]));
    const approved = identities.size === 1 ? identities.values().next().value : undefined;
    const canonical = linked ?? (approved ? modelFacet(approved) : undefined);
    if (canonical) {
      canonical.matches.push(...option.matches);
      if (!linked) models.push(canonical);
    } else models.push(option);
  }
  return {
    brand: brand ? [{ value: fold(brand), label: brand, matches: [brand] }] : [],
    model: models,
    design: optionFacet(variant, designKeys),
    color: optionFacet(variant, colorKeys),
    availability: [{ value: variant.availability, label: variant.availability, matches: [variant.availability] }],
  };
}

function attributeOf(raw: unknown, key: string) {
  if (!raw || typeof raw !== "object" || !Object.hasOwn(raw, key)) return undefined;
  return (raw as Record<string, unknown>)[key];
}

function typedAttributes(templates: readonly EffectiveCategoryAttribute[], row: CatalogVariantRow, variant: PublicVariant) {
  const attributes = new Map<string, Attribute>();
  for (const definition of templates) {
    if (!definition.filterable) continue;
    const value = definition.variantOptionKey ? variant.options.find(option => option.key === definition.variantOptionKey)?.value
      : definition.scope === "PRODUCT" ? attributeOf(row.product.attributeValues, definition.id) : variant.attributes[definition.id];
    if (definition.dataType === "NUMBER" ? typeof value === "number" && Number.isFinite(value)
      : definition.dataType === "BOOLEAN" ? typeof value === "boolean"
        : typeof value === "string" && (definition.dataType !== "ENUM" || definition.allowedValues.includes(value))) {
      attributes.set(definition.id, { value: value as AttributeValue, definition });
    }
  }
  return attributes;
}

function matchSelections<T>(selected: readonly { key: string; value: T }[], matches: (key: string, value: T) => boolean) {
  // Values within one key are alternatives. Each distinct key must match this candidate.
  return [...new Set(selected.map(({ key }) => key))].every(key =>
    selected.some(value => value.key === key && matches(key, value.value)));
}

function matchListing(variant: PublicVariant, facets: Facets, attributes: Map<string, Attribute>, filters: CatalogListingInput) {
  for (const key of Object.keys(facets) as FacetKey[]) {
    const wanted: readonly string[] = filters[key];
    if (wanted.length && !facets[key].some(value => value.matches.some(match =>
      wanted.some(want => fold(want) === fold(match) || key === "model" && sameModel(want, match))))) return false;
  }
  if (!matchSelections(filters.option, (key, value) => variant.options.some(option =>
    (key === deviceLookupKey(option.key) || option.optionId && key === deviceLookupKey(option.optionId)) &&
    [option.value, option.valueLabel, option.valueId].some(optionValue =>
      optionValue && fold(optionValue) === fold(value))))) return false;
  if (!matchSelections(filters.attribute, (key, value) => attributes.get(key)?.value === value)) return false;

  return matchOffer(variant, filters);
}

function matchOffer(variant: PublicVariant, { minMinor, maxMinor, sale }: CatalogListingInput) {
  const offer = variant.offer;
  if (minMinor !== undefined || maxMinor !== undefined || sale !== undefined) {
    if (!offer.eligible || minMinor !== undefined && offer.amountMinor < minMinor || maxMinor !== undefined && offer.amountMinor > maxMinor ||
      sale !== undefined && (offer.amountMinor < offer.regularMinor) !== sale) return false;
  }
  return true;
}

function modelSearchTerms(model: { id: string; name: string; brand: string; aliases: readonly string[] }): SearchModel {
  return { id: model.id, label: model.name, names: [model.name, `${model.brand} ${model.name}`, ...model.aliases] };
}

function searchTerms(variant: PublicVariant) {
  const models = variant.compatibility.map(modelSearchTerms);
  const options: SearchOption[] = [];
  for (const { key, value, valueLabel } of variant.options) {
    const option = { label: valueLabel, names: [value, valueLabel] };
    if (modelKeys.has(deviceLookupKey(key))) models.push(option);
    else options.push(option);
  }
  return { models, options };
}

type Counted<T> = { value: T; label: string; parents: Set<string> };
type CountMap<T> = Map<T, Counted<T>>;
type FacetCounts = Record<FacetKey, CountMap<string>>;
type AttributeCounts = Map<string, { name: string; dataType: string; values: CountMap<AttributeValue> }>;

function count<T>(counts: CountMap<T>, productId: string, value: T, label: string) {
  const item = counts.get(value) ?? { value, label, parents: new Set<string>() };
  item.parents.add(productId);
  counts.set(value, item);
}

function countFacets(productId: string, groups: FacetCounts, typed: AttributeCounts, facets: Facets, attributes: Map<string, Attribute>) {
  for (const key of Object.keys(groups) as FacetKey[]) {
    for (const facet of facets[key]) count(groups[key], productId, facet.value, facet.label);
  }
  for (const [id, { definition, value }] of attributes) {
    const attribute = typed.get(id) ?? { name: definition.name, dataType: definition.dataType, values: new Map() };
    count(attribute.values, productId, value, String(value));
    typed.set(id, attribute);
  }
}

function facetView<T>(counts: CountMap<T>, locale: string) {
  return [...counts.values()].map(({ value, label, parents }) => ({ value, label, count: parents.size }))
    .sort((a, b) => a.label.localeCompare(b.label, locale, { numeric: true }) || stableOrder(String(a.value), String(b.value)));
}

function priceOrder(a: Candidate, b: Candidate) {
  return a.variant.offer.amountMinor - b.variant.offer.amountMinor || Number(b.variant.isDefault) - Number(a.variant.isDefault) ||
    a.variant.position - b.variant.position || stableOrder(a.variant.id, b.variant.id);
}

function commonOptions(candidates: Candidate[]) {
  return candidates[0].variant.options.filter(option => candidates.every(({ variant }) =>
    variant.options.some(value => value.key === option.key && value.value === option.value && value.valueId === option.valueId)));
}

function groupCard(group: Group, currency: PublicVariant["offer"]["currency"], search: boolean) {
  const { candidates, product, position, addedOn } = group;
  const eligible = candidates.filter(({ variant }) => variant.offer.eligible);
  const available = eligible.filter(({ variant }) => variant.availability === "available");
  const priced = (available.length ? available : eligible).sort(priceOrder);
  const bestScore = Math.max(...candidates.map(({ score }) => score));
  const bestMatches = candidates.filter(({ score }) => score === bestScore);
  const representative = priced.find(candidate => candidate.score === bestScore) ?? [...bestMatches].sort(priceOrder)[0];
  const { id: variantId, sku, image, options, offer, availability } = representative.variant;
  const linked = search && bestScore === searchSpellingScore ? [] : search ? candidates : bestMatches;
  const lowest = priced[0]?.variant.offer.amountMinor;
  const highest = priced.at(-1)?.variant.offer.amountMinor;
  return {
    score: bestScore, position, addedOn,
    card: {
      id: product.id, slug: product.slug, name: product.name, brand: product.brand, shortDescription: product.shortDescription,
      primaryCategoryId: product.primaryCategoryId, secondaryCategoryIds: product.secondaryCategoryIds,
      matchingVariantIds: [...candidates].sort((a, b) => a.variant.position - b.variant.position || stableOrder(a.variant.id, b.variant.id))
        .map(({ variant }) => variant.id),
      matchedVariantId: linked.length === 1 ? linked[0].variant.id : null,
      knownOptions: linked.length ? commonOptions(linked) : [],
      searchMatch: representative.searchMatch,
      representative: { variantId, sku, image, options, offer, availability },
      fromPrice: lowest !== undefined && highest !== undefined ? { currency, amountMinor: lowest, maxAmountMinor: highest } : null,
    },
  };
}

type GroupCard = ReturnType<typeof groupCard>;
function compareCards(sort: CatalogListingInput["sort"], a: GroupCard, b: GroupCard, locale: string) {
  const aPrice = a.card.fromPrice?.amountMinor;
  const bPrice = b.card.fromPrice?.amountMinor;
  switch (sort) {
    case "price-low":
    case "price-high":
      return Number(aPrice === undefined) - Number(bPrice === undefined) ||
        ((aPrice ?? 0) - (bPrice ?? 0)) * (sort === "price-low" ? 1 : -1);
    case "newest": return b.addedOn.getTime() - a.addedOn.getTime();
    case "name": return a.card.name.localeCompare(b.card.name, locale);
    default: return b.score - a.score || a.position - b.position;
  }
}

export async function listConnectedCatalog(params: URLSearchParams, context: CatalogReadContext, db: PrismaClient = getDb(),
  now = new Date(), options?: { browsePage?: number; search?: true; suggest?: true; keepUnmatchedFacets?: boolean; productIds?: readonly string[] }) {
  const filters = parseCatalogListing(params);
  const scope = listingScope(filters, context);
  const { marketId, locale } = context;
  const browseEnabled = options?.browsePage !== undefined;
  if (!isMarketSelectable(marketId)) throw new CatalogApiError(400, "invalid_market", "Choose a browsable market.");
  const { currency } = markets[marketId];
  return db.$transaction(async tx => {
    const productWhere: Prisma.ProductWhereInput[] = options?.productIds ? [{ id: { in: [...options.productIds] } }] : [];
    let categoryId: string | null = null;
    let collectionId: string | null = null;
    let collectionOrder: ReadonlyMap<string, number> | undefined;
    if (filters.category) {
      const found = await resolveConnectedCategory(filters.category, marketId, locale, tx);
      if (!found) throw new CatalogApiError(404, "category_not_found", "This category is unavailable.");
      categoryId = found.category.id;
      const ids = found.descendants.map(({ id }) => id);
      productWhere.push({ OR: [{ departmentId: { in: ids } }, { secondaryCategories: { some: { departmentId: { in: ids } } } }] });
    }
    if (filters.collection) {
      const collection = await resolveConnectedCollection(filters.collection, tx, marketId);
      if (!collection) throw new CatalogApiError(404, "collection_not_found", "This collection is unavailable.");
      collectionId = collection.id;
      productWhere.push(connectedCollectionProductFilter(collection));
      if (collection.selection === "CURATED") {
        const members = await tx.collectionProduct.findMany({ where: { collectionId }, select: { productId: true },
          orderBy: orderedCollectionProducts });
        collectionOrder = new Map(members.map(({ productId }, position) => [productId, position]));
      }
    }

    const rows = await tx.variant.findMany({
      where: { AND: [catalogVariantWhere(marketId), { product: { AND: productWhere } }] },
      include: catalogVariantInclude(context),
      orderBy: { id: "asc" }, take: maxCandidates + 1,
    });
    if (rows.length > maxCandidates) {
      throw new CatalogApiError(422, "catalog_scope_too_broad", "Choose a narrower category or collection to retrieve exact counts.");
    }
    const variants = new Map((await catalogVariants(rows, context, tx, now, browseEnabled || options?.search ? { browseLegacyStock: true } : undefined))
      .map(variant => [variant.id, variant]));
    const rawQuery = filters.q;
    const phrases = rawQuery ? [...new Set(searchablePhrases(rawQuery).map(deviceLookupKey))] : [];
    const [templates, categories, explicitModels] = await Promise.all([
      categoryAttributesForMany(rows.map(({ product }) => product.departmentId), tx),
      rawQuery ? listCategoryPresentation(marketId, locale, tx) : [],
      phrases.length ? tx.deviceModel.findMany({
        where: { OR: [{ lookupKey: { in: phrases } }, { aliases: { some: { lookupKey: { in: phrases } } } }] },
        select: { id: true, brand: true, name: true, aliases: { select: { label: true } } }, orderBy: { id: "asc" },
      }) : [],
    ]);
    const categoryById = new Map(categories.map(item => [item.id, item]));
    const categoryText = new Map<string, string[]>();
    const fields = rawQuery ? new Map([...variants].map(([id, variant]) => [id, searchTerms(variant)])) : new Map<string, ReturnType<typeof searchTerms>>();
    const parentOptions = new Map<string, SearchOption[]>();
    for (const { id, productId } of rows) {
      const values = fields.get(id)?.options;
      if (!values?.length) continue;
      const combined = parentOptions.get(productId) ?? [];
      combined.push(...values);
      parentOptions.set(productId, combined);
    }
    const reviewedModels = explicitModels.map(model => ({ ...model, aliases: model.aliases.map(({ label }) => label) }));
    const modelIndex = options?.search ? indexModels([...reviewedModels, ...[...variants.values()].flatMap(variant => variant.compatibility)]) : undefined;
    const search = rawQuery ? catalogSearchMatcher(rawQuery, [
      ...[...fields.values()].flatMap(({ models }) => models),
      ...reviewedModels.map(modelSearchTerms),
    ], options?.suggest) : null;
    const groups = new Map<string, Group>();
    const publicProducts = new Map<string, PublicProduct>();
    const counts: FacetCounts = { brand: new Map(), model: new Map(), design: new Map(), color: new Map(), availability: new Map() };
    const typed: AttributeCounts = new Map();
    const candidates = rows.flatMap(row => {
      const variant = variants.get(row.id);
      if (!variant || variant.offer.currency !== currency) return [];
      const source = row.product;
      const product = publicProducts.get(source.id) ?? catalogProduct(source, context);
      publicProducts.set(source.id, product);
      const facets = candidateFacets(product.brand, variant, modelIndex);
      const attributes = typedAttributes(templates.get(source.departmentId) ?? [], row, variant);
      const terms = fields.get(row.id);
      let result;
      if (search && terms) {
        let categoryNames = categoryText.get(source.id);
        if (!categoryNames) {
          const ancestors = [product.primaryCategoryId, ...product.secondaryCategoryIds].flatMap(id => departmentAncestorPath(categoryById, id) ?? []);
          categoryNames = [...new Set(ancestors.flatMap(category => [category.name, category.shortName]))];
          categoryText.set(source.id, categoryNames);
        }
        result = search({ sku: variant.sku, modelNumber: row.mpn, gtin: row.gtin, label: variant.label, title: product.name, ...terms,
          text: [source.name, source.description, product.brand ?? "", product.description, product.shortDescription ?? "",
            ...source.keywords, ...categoryNames, ...product.specifications.flatMap(({ label, value }) => [label, value]),
            ...[...attributes.values()].map(({ definition, value }) => `${definition.name} ${String(value)}`)],
        }, parentOptions.get(source.id) ?? []);
      }
      const score = search ? result?.score ?? -1 : 0;
      const browse = browseEnabled ? browseCandidateFacets(variant, facets, attributes) : [];
      return [{ variant, source, product, score, searchMatch: result?.match, facets, attributes, browse }];
    });
    const strongest = candidates.reduce((score, item) => Math.max(score, item.score), -1);
    const minScore = strongest >= exactSearchIdentifierScore ? strongest : strongest > searchSpellingScore ? searchSpellingScore + 1 : 0;
    const reconciled = browseEnabled ? reconcileBrowseFacets(filters, candidates.map(candidate => candidate.browse),
      options?.keepUnmatchedFacets ?? options?.search) : null;
    const activeFilters = reconciled?.retained ?? filters;
    const browseFacets = browseEnabled ? browseFacetCounts(activeFilters, locale) : null;
    const modelSuggestions = new Map<string, string>();
    for (const { variant, source, product, score, searchMatch, facets, attributes, browse } of candidates) {
      if (!options?.search || score >= minScore) browseFacets?.observe(product.id, browse, score >= minScore && matchOffer(variant, activeFilters));
      if (score < minScore || !matchListing(variant, facets, attributes, activeFilters)) continue;
      countFacets(product.id, counts, typed, facets, attributes);
      if (options?.suggest && rawQuery && strongest < exactSearchSkuScore) for (const model of facets.model) {
        if (model.label === searchMatch?.label || model.matches.some(name => searchSuggestionName(rawQuery, name))) {
          modelSuggestions.set(model.value, model.label);
        }
      }
      const group = groups.get(product.id) ?? { product, position: collectionOrder?.get(product.id) ?? source.position,
        addedOn: source.addedOn, candidates: [] };
      group.candidates.push({ variant, score, searchMatch });
      groups.set(product.id, group);
    }

    const cards = [...groups.values()].map(group => groupCard(group, currency, Boolean(options?.search))).sort((a, b) =>
      compareCards(filters.sort, a, b, locale) || stableOrder(a.card.id, b.card.id)).map(({ card }) => card);
    const amounts = cards.flatMap(card => card.fromPrice ? [card.fromPrice.amountMinor, card.fromPrice.maxAmountMinor] : []);
    const pageCount = Math.max(1, Math.ceil(cards.length / filters.limit));
    const browsePage = Math.min(pageCount, Math.max(1, options?.browsePage ?? 1));
    const availablePrices = browseEnabled ? candidates.filter(({ variant, score }) => variant.offer.eligible &&
      (!options?.search || score >= minScore)).map(({ variant }) => variant.offer.amountMinor) : [];
    const browse = browseFacets && reconciled ? {
      page: browsePage, pageCount, facets: browseFacets.view(), selected: reconciled.selected.toString(), removed: reconciled.removed,
      price: availablePrices.length ? { currency, minMinor: Math.min(...availablePrices), maxMinor: Math.max(...availablePrices) } : null,
    } : undefined;
    return {
      marketId, locale, currency, categoryId, collectionId, total: cards.length,
      facets: {
        brand: facetView(counts.brand, locale), model: facetView(counts.model, locale), design: facetView(counts.design, locale),
        color: facetView(counts.color, locale), availability: facetView(counts.availability, locale),
        attributes: [...typed.entries()].sort(([a], [b]) => stableOrder(a, b)).map(([id, attribute]) => ({
          id, name: attribute.name, dataType: attribute.dataType, values: facetView(attribute.values, locale),
        })),
        price: amounts.length ? { currency, minMinor: Math.min(...amounts), maxMinor: Math.max(...amounts) } : null,
      },
      browse,
      suggestions: options?.suggest && rawQuery ? {
        categories: categories.filter(category => category.visibleInNavigation && [category.name, category.shortName]
          .some(name => searchSuggestionName(rawQuery, name))).slice(0, 4),
        models: [...modelSuggestions].map(([id, name]) => ({ id, name })).sort((a, b) =>
          a.name.localeCompare(b.name, locale, { numeric: true }) || stableOrder(a.id, b.id)).slice(0, 4),
      } : undefined,
      ...(browse ? { items: cards.slice((browsePage - 1) * filters.limit, browsePage * filters.limit), nextCursor: null }
        : listingPage(cards, filters, scope)),
    };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
