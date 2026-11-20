import type { SearchParams } from "./listing.ts";

export const browseFilterFields = [
  "brand", "model", "design", "color", "option", "attribute", "availability", "minMinor", "maxMinor", "sale",
] as const;

const browseFields = new Set<string>([
  ...browseFilterFields, "priceCurrency", "device", "offer", "min", "max", "minPrice", "maxPrice", "browseFrom",
  "page", "cursor", "sort", "q", "category", "department", "collection", "market", "lang", "country", "district",
  "method", "postalCode", "paymentMethod", "quantity",
]);

export function browseParamsWithoutFilters(query: string) {
  const params = new URLSearchParams(query);
  for (const field of [...browseFilterFields, "priceCurrency", "page", "cursor"]) params.delete(field);
  return params;
}

export function clearBrowseFilters(path: string, query: string) {
  const params = browseParamsWithoutFilters(query);
  return params.size ? `${path}?${params}` : path;
}

function browseState(params: URLSearchParams) {
  const state = new URLSearchParams();
  for (const [name, value] of params) if (browseFields.has(name)) state.append(name, value);
  state.sort();
  return state.toString();
}

export function browseRequestState(raw: SearchParams) {
  const params = new URLSearchParams();
  for (const [name, values] of Object.entries(raw)) {
    for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) params.append(name, value);
  }
  return browseState(params);
}

export function needsBrowseUrlNormalization(source: string, page: number, hasNotice: boolean) {
  const params = new URLSearchParams(source);
  const pages = params.getAll("page");
  const transient = ["browseFrom", "cursor", "minPrice", "maxPrice", "min", "max"].some(name => params.has(name));
  return hasNotice || transient ||
    (pages.length > 0 && (page === 1 || pages.length !== 1 || pages[0] !== String(page)));
}

export function normalizedBrowseUrl(current: URL, source: string, query: string, page: number) {
  if (browseState(current.searchParams) !== source) return null;
  const next = new URL(current);
  for (const name of browseFields) next.searchParams.delete(name);
  for (const [name, value] of new URLSearchParams(query)) next.searchParams.append(name, value);
  if (page > 1) next.searchParams.set("page", String(page));
  return next.href === current.href ? null : next;
}
