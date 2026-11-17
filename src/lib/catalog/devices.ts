import type { CatalogProduct } from "./types.ts";

export type PhoneModel = { id: string; name: string; family: string };
type ModelMention = { model: PhoneModel; start: number; end: number };

export function normalizeSearchText(text: string) {
  return text.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").toLowerCase()
    .replace(/\+/g, " plus ").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

function modelPattern(body: string) {
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${body})(?![\\p{L}\\p{N}\\p{M}])`, "gu");
}

const patterns = [
  {
    brand: "iPhone",
    pattern: modelPattern(String.raw`(?:apple\s*)?i\s*phone\s*(\d{1,2}|xs|xr|x|se)(?:\s*(pro\s*max|pmax|pm|plus|pro|mini|air|max|e))?`),
  },
  {
    brand: "Samsung Galaxy",
    pattern: modelPattern(String.raw`(?:samsung\s*(?:galaxy\s*)?|galaxy\s*)([samf]\s*\d{2}|note\s*\d{1,2})(?:\s*(ultra|plus|edge|fe|u))?`),
  },
  {
    brand: "Samsung Galaxy",
    pattern: modelPattern(String.raw`(s\s*\d{2})(?:\s*(ultra|plus|edge|fe|u))?`),
  },
  {
    brand: "Google Pixel",
    pattern: modelPattern(String.raw`(?:google\s*)?pixel\s*(\d{1,2})(?:\s*(pro\s*xl|pro\s*fold|fold|pro|xl|a))?`),
  },
  {
    brand: "iQOO",
    pattern: modelPattern(String.raw`(?:i\s*qoo\s*)?(z\s*\d{1,2})(?:\s*(turbo\s*pro|turbo\s*plus|turbo|x|r))?`),
  },
  {
    brand: "iQOO Neo",
    pattern: modelPattern(String.raw`(?:i\s*qoo\s*)?neo\s*(\d{1,2})(?:\s*(pro|s|se))?`),
  },
  {
    brand: "Redmi",
    pattern: modelPattern(String.raw`(?:xiaomi\s*)?redmi\s*(turbo\s*\d{1,2}|k\s*\d{2}|note\s*\d{1,2})(?:\s*(pro\s*plus|pro|max|ultra))?`),
  },
  {
    brand: "Redmi",
    pattern: modelPattern(String.raw`(turbo\s*\d{1,2})(?:\s*(pro\s*plus|pro|max|ultra))?`),
  },
  {
    brand: "Honor",
    pattern: modelPattern(String.raw`honor\s*(\d{2,3}|magic\s*\d{1,2})(?:\s*(pro|lite|smart|ultra))?`),
  },
  {
    brand: "Nothing Phone",
    pattern: modelPattern(String.raw`nothing\s*(?:phone\s*)?(\d{1,2}\s*[a-z]?)(?:\s*(pro|plus))?`),
  },
  {
    brand: "CMF Phone",
    pattern: modelPattern(String.raw`cmf\s*(?:phone\s*)?(\d{1,2})(?:\s*(pro|plus))?`),
  },
];

const displayWords: Record<string, string> = {
  a: "a", e: "e", fe: "FE", pro: "Pro", plus: "Plus", max: "Max", mini: "Mini", air: "Air", ultra: "Ultra",
  edge: "Edge", xl: "XL", fold: "Fold", turbo: "Turbo", x: "X", r: "R", s: "S", se: "SE", lite: "Lite", smart: "Smart",
};

function baseName(brand: string, base: string) {
  const compact = base.replaceAll(" ", "");
  if (brand === "Nothing Phone") return `(${compact})`;
  if (brand === "Google Pixel" || brand === "CMF Phone") return compact;
  if (/^(?:turbo|note|magic)\d/.test(compact)) return compact.replace(/^([a-z])([a-z]+)(\d+)/, (_, head, word, model) => `${head.toUpperCase()}${word} ${model}`);
  return compact.toUpperCase();
}

function modelName(brand: string, base: string, variant: string) {
  const model = baseName(brand, base);
  if (brand === "Google Pixel" && variant === "a" || brand === "iPhone" && variant === "e") return `${brand} ${model}${variant}`;
  const suffix = variant.split(" ").map(word => displayWords[word]).filter(Boolean).join(" ");
  return [brand, model, suffix].filter(Boolean).join(" ");
}

function canonicalBase(base: string) {
  return base.replaceAll(" ", "").replace(/^(turbo|note|magic)(\d+)/, "$1-$2");
}

function modelVariant(raw: string, brand: string) {
  const compact = raw.replaceAll(" ", "");
  if (brand === "iPhone" && ["pm", "pmax"].includes(compact)) return "pro max";
  if (brand === "Samsung Galaxy" && compact === "u") return "ultra";
  return compact.replace(/^(pro|turbo)(max|xl|fold|pro|plus)$/, "$1 $2");
}

export function modelMentions(normalized: string): ModelMention[] {
  const mentions = patterns.flatMap(({ brand, pattern }) => Array.from(normalized.matchAll(pattern), match => {
    const [text, base, rawVariant = ""] = match;
    const variant = modelVariant(rawVariant, brand);
    const family = `${brand.toLowerCase().replaceAll(" ", "-")}-${canonicalBase(base)}`;
    const attached = brand === "Google Pixel" && variant === "a" || brand === "iPhone" && variant === "e";
    const id = variant ? `${family}${attached ? "" : "-"}${variant.replaceAll(" ", "-")}` : family;
    const model = { id, family, name: modelName(brand, base, variant) };
    return { model, start: match.index, end: match.index + text.length };
  }));
  mentions.sort((a, b) => a.start - b.start || b.end - a.end);
  const clean: ModelMention[] = [];
  for (const mention of mentions) if (mention.start >= (clean.at(-1)?.end ?? 0)) clean.push(mention);
  return clean;
}

function distinct(models: readonly PhoneModel[]) {
  return [...new Map(models.map(model => [model.id, model])).values()];
}

export function phoneModels(text: string): PhoneModel[] {
  return distinct(modelMentions(normalizeSearchText(text)).map(({ model }) => model));
}

export function catalogDeviceById(id: string): PhoneModel | undefined {
  return phoneModels(id).find(model => model.id === id);
}

export function fitsSearchDevice(model: PhoneModel, requested: PhoneModel) {
  const familyAlias = requested.id === requested.family && /^iqoo-z\d{1,2}$/.test(requested.family);
  return model.id === requested.id || (familyAlias && model.family === requested.family);
}

const fitKey = /^(?:(?:phone|device)(?: models?| types?| compatibility)?|models?|compatibility|compatible (?:with|models?|devices?)|fits?|fits models?)$/;

export function variantDeviceModels(options: Readonly<Record<string, string>>) {
  const values = Object.entries(options);
  const labeled = values.filter(([key]) => fitKey.test(normalizeSearchText(key)));
  const models = distinct((labeled.length ? labeled : values).flatMap(([, value]) => phoneModels(value)));
  return { explicit: labeled.length > 0 || models.length > 0, models };
}

function fullModelTag(tag: string) {
  const cleaned = normalizeSearchText(tag);
  return modelMentions(cleaned).filter(match => match.start === 0 && match.end === cleaned.length).map(({ model }) => model);
}

type ModelProduct = Pick<CatalogProduct, "keywords"> & Partial<Pick<CatalogProduct, "name" | "specifications" | "variants">>;

export function productDeviceModels(product: ModelProduct): PhoneModel[] {
  // Full titles beat copied title-like keywords, which can omit a suffix.
  const title = product.name ? phoneModels(product.name) : [];
  if (title.length) return title;
  const exactTags = distinct(product.keywords.flatMap(fullModelTag));
  if (exactTags.length) return exactTags;
  const specs = Array.isArray(product.specifications) ? product.specifications : [];
  const specModels = distinct(specs.flatMap(spec => fitKey.test(normalizeSearchText(spec.label)) ? phoneModels(spec.value) : []));
  return specModels.length ? specModels : distinct(product.keywords.flatMap(phoneModels));
}

export function deviceModelsByVariant(product: ModelProduct & Required<Pick<CatalogProduct, "variants">>) {
  const fits = product.variants.map(variant => ({ variant, ...variantDeviceModels(variant.options) }));
  if (fits.some(fit => fit.explicit)) return fits;
  const fallback = productDeviceModels(product);
  return fits.map(fit => ({ ...fit, models: fallback }));
}

const featuredModels = [
  "iphone-16-pro-max", "iphone-16-pro", "iphone-15-pro-max", "iphone-15-pro", "iphone-14-pro",
  "samsung-galaxy-s25-ultra", "samsung-galaxy-s24-ultra", "iqoo-z11-turbo", "iqoo-z10-turbo", "iqoo-z9-turbo",
  "iqoo-neo-11", "iqoo-neo-10", "iqoo-neo-9", "redmi-turbo-4-pro", "redmi-k80",
  "honor-400-pro", "honor-400", "honor-200-pro", "honor-200", "nothing-phone-3a", "cmf-phone-2-pro",
];
const featuredPosition = new Map(featuredModels.map((model, index) => [model, index]));

export function catalogDevices(products: readonly ModelProduct[]): PhoneModel[] {
  const models = products.flatMap(product => product.variants
    ? deviceModelsByVariant({ ...product, variants: product.variants }).flatMap(fit => fit.variant.offer ? fit.models : [])
    : productDeviceModels(product));
  return distinct(models).sort((a, b) =>
    (featuredPosition.get(a.id) ?? featuredModels.length) - (featuredPosition.get(b.id) ?? featuredModels.length) ||
    a.name.localeCompare(b.name, "en", { numeric: true }));
}
