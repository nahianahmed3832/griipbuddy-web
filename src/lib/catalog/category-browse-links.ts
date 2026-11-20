import type { MarketId } from "../../config/markets.ts";
import { localizedStorePath, productLandingPath } from "../../config/regional-path.ts";
import { deviceLookupKey } from "./device-fitment.ts";
import type { SearchParams } from "./listing.ts";

type Context = { id: MarketId; locale: string; regional: boolean };
type SelectedOption = { key: string; value: string; optionId: string | null; valueId: string | null };

export function catalogBrowseHref(path: string, context: Context, query = new URLSearchParams()) {
  const params = new URLSearchParams(query);
  params.set("market", context.id);
  params.set("lang", context.locale);
  return `${context.regional ? localizedStorePath(path, context.id) : path}?${params}`;
}

export function catalogProductHref(product: { slug: string; matchedVariantId: string | null; knownOptions: readonly SelectedOption[] },
  context: Context, categoryId?: string) {
  const base = productLandingPath(product.slug, context.id, context.regional, product.matchedVariantId ?? undefined);
  const [path, query] = base.split("?");
  const params = new URLSearchParams(query);
  params.set("browse", "1");
  if (categoryId) params.set("category", categoryId);
  if (!product.matchedVariantId) {
    for (const option of product.knownOptions) params.append("option", `${option.optionId ?? option.key}:${option.valueId ?? option.value}`);
  }
  params.set("lang", context.locale);
  return `${path}?${params}`;
}

export function browseProductSelection(raw: SearchParams["option"]) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const items = new Map<string, string>();
  for (const item of values.slice(0, 24)) {
    const separator = item.indexOf(":");
    const value = item.slice(separator + 1).normalize("NFKC").toLowerCase();
    if (separator < 1 || item.length > 200 || !value || /\p{Cc}/u.test(item)) continue;
    const key = deviceLookupKey(item.slice(0, separator));
    if (key && !items.has(key)) items.set(key, value);
  }
  return items;
}

export function matchesBrowseProductSelection(options: readonly SelectedOption[], selections: ReadonlyMap<string, string>) {
  return [...selections].every(([key, value]) => options.some(option =>
    [option.key, option.optionId].some(id => id && deviceLookupKey(id) === key) &&
    [option.value, option.valueId].some(id => id?.normalize("NFKC").toLowerCase() === value)));
}
