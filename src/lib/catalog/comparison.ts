import { catalogBrowseHref } from "./catalog-browse-href.ts";

export const comparisonLimit = 3;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function comparisonProducts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 24).filter((entry): entry is string =>
    typeof entry === "string" && entry.length <= 120 && slug.test(entry)))].slice(0, comparisonLimit);
}

export function comparisonHref(context: Parameters<typeof catalogBrowseHref>[1], products: readonly string[]) {
  const query = new URLSearchParams();
  for (const product of comparisonProducts(products)) query.append("product", product);
  return catalogBrowseHref("/compare", context, query);
}
