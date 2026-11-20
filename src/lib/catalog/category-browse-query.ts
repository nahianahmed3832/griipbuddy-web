import { createHash } from "node:crypto";
import { isMarketId, markets, type Market } from "../../config/markets.ts";
import { priceInMinor } from "./browse-price-input.ts";
import { browseFilterFields } from "./browse-url-state.ts";
import { browseFacetLabels } from "./category-browse-facets.ts";
import { parseCatalogListing } from "./connected-listing-input.ts";
import { catalogDelivery } from "./connected-public.ts";
import type { SearchParams } from "./listing.ts";

const deliveryFields = ["country", "district", "method", "postalCode", "paymentMethod", "quantity"];
const facetFields = ["brand", "model", "design", "color", "option", "attribute", "availability"] as const;
const facetNames = { ...browseFacetLabels, option: "Option", attribute: "Specification" };
const filterFields: ReadonlySet<string> = new Set(browseFilterFields);
const browsePageSize = parseCatalogListing(new URLSearchParams()).limit;

function singleton(raw: SearchParams, name: string) {
  return typeof raw[name] === "string" ? raw[name] : undefined;
}

function all(raw: SearchParams, name: string) {
  const value = raw[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function appendValid(params: URLSearchParams, name: string, value: string | undefined) {
  if (!value) return true;
  try {
    parseCatalogListing(new URLSearchParams([[name, value]]));
  } catch {
    return false;
  }
  params.append(name, value);
  return true;
}

function fixedSide(raw: SearchParams, side: "min" | "max", market: Market) {
  const major = singleton(raw, `${side}Price`) || singleton(raw, side);
  const minor = singleton(raw, `${side}Minor`);
  const value = major ? priceInMinor(major, market.minorDigits) : minor;
  if (value === undefined && !major && !minor) return { valid: true } as const;
  if (!value || !/^\d{1,10}$/.test(value) || Number(value) > 2_147_483_647) return { valid: false } as const;
  return { valid: true, value: String(Number(value)) } as const;
}

export function prepareCategoryBrowseQuery(raw: SearchParams, market: Market, scope: { category?: string; collection?: string }) {
  const context = new URLSearchParams({ market: market.id, lang: market.locale });
  const fromMarket = singleton(raw, "browseFrom");
  const changedMarket = isMarketId(fromMarket) && fromMarket !== market.id;
  const otherCurrency = changedMarket && markets[fromMarket].currency !== market.currency ||
    Boolean(singleton(raw, "priceCurrency") && singleton(raw, "priceCurrency") !== market.currency);

  const params = new URLSearchParams();
  const removed = new Set<string>();
  for (const { key, value } of [{ key: "category", value: scope.category }, { key: "collection", value: scope.collection }]) {
    if (value) params.set(key, value);
  }
  if (!appendValid(params, "sort", singleton(raw, "sort")) || all(raw, "sort").length > 1) removed.add("Sort order");
  if (!appendValid(params, "q", singleton(raw, "q")?.trim()) || all(raw, "q").length > 1) removed.add("Search");

  for (const field of facetFields) {
    let values = all(raw, field);
    if (field === "model" && !values.length) values = all(raw, "device");
    if (field === "availability") values = values.map(value => value === "in-stock" ? "available" : value);
    const limit = field === "option" || field === "attribute" ? 24 : field === "availability" ? 4 : 12;
    const unique = [...new Set(values.map(value => value.trim()).filter(Boolean))];
    if (unique.length > limit) removed.add(facetNames[field]);
    for (const value of unique.slice(0, limit)) {
      if (!appendValid(params, field, value)) removed.add(facetNames[field]);
    }
  }
  const sale = singleton(raw, "sale") || (singleton(raw, "offer") === "sale" ? "true" : undefined);
  if (!appendValid(params, "sale", sale) || all(raw, "sale").length > 1) removed.add("Sale");
  const min = fixedSide(raw, "min", market);
  const max = fixedSide(raw, "max", market);
  const priceFields = ["minPrice", "maxPrice", "minMinor", "maxMinor", "min", "max"];
  const suppliedPrice = priceFields.some(key => all(raw, key).some(Boolean));
  if (suppliedPrice && (otherCurrency || priceFields.some(key => all(raw, key).length > 1) || !min.valid || !max.valid ||
    min.value !== undefined && max.value !== undefined && Number(min.value) > Number(max.value))) {
    removed.add("Price");
  } else {
    if (min.value !== undefined) params.set("minMinor", min.value);
    if (max.value !== undefined) params.set("maxMinor", max.value);
  }

  const destination = new URLSearchParams();
  for (const field of deliveryFields) {
    for (const value of all(raw, field)) if (value) destination.append(field, value);
  }
  let delivery;
  if (destination.size) {
    try {
      if (!changedMarket && destination.get("country") === market.countryCode) {
        delivery = catalogDelivery(new URLSearchParams(destination));
      }
    } catch { /* The unavailable destination is explained below. */ }
    if (!delivery) removed.add("Delivery");
    else for (const [name, value] of destination) context.append(name, value);
  }

  const rawPage = singleton(raw, "page");
  const page = !changedMarket && rawPage && /^\d{1,5}$/.test(rawPage) ? Math.max(1, Number(rawPage)) : 1;
  for (const [name, value] of params) {
    if (name !== "category" && name !== "collection") context.append(name, value);
  }
  if (params.has("minMinor") || params.has("maxMinor")) context.set("priceCurrency", market.currency);
  const rawSort = params.get("sort");
  const sort = rawSort ? parseCatalogListing(new URLSearchParams({ sort: rawSort })).sort : undefined;
  return { params, query: context.toString(), page, pageSize: browsePageSize, sort, delivery, removed: [...removed], changedMarket };
}

export type CategoryBrowseFilterField = (typeof facetFields)[number] | "price" | "sale" | "size";

export function categoryBrowseControls(
  prepared: ReturnType<typeof prepareCategoryBrowseQuery>,
  browse?: { selected: string; removed: string[] } | null,
) {
  const params = new URLSearchParams(prepared.query);
  if (browse) {
    for (const field of facetFields) params.delete(field);
    for (const [field, value] of new URLSearchParams(browse.selected)) params.append(field, value);
  }
  const filters = [...params].filter(([field]) => filterFields.has(field));
  const fields = new Set<CategoryBrowseFilterField>();
  for (const [field, value] of filters) {
    if (field === "minMinor" || field === "maxMinor") fields.add("price");
    else if (field === "option" && value.startsWith("size:")) fields.add("size");
    else fields.add(field as CategoryBrowseFilterField);
  }
  const removed = [...new Set([...prepared.removed, ...(browse?.removed ?? [])])];
  const filterKey = createHash("sha256").update(JSON.stringify(filters.map(([key, value]) => `${key}=${value}`).sort()))
    .digest("hex");
  return { query: params.toString(), filterKey, filterFields: [...fields], hasFilters: filters.length > 0,
    active: Boolean(filters.length || params.has("q")),
    notice: removed.length ? `Some selections were removed ${prepared.changedMarket ? "because they don’t apply in this market" :
      "because they’re unavailable or invalid"}: ${removed.join(", ")}.` : undefined };
}
