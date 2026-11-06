import 'server-only';
import { validSlug, type CatalogProduct, type CatalogVariant, type Category, type Market, type Money } from './catalog';
import { approvedCatalogImage } from './media';

export class CatalogError extends Error {}

export function apiConfigured() {
  return Boolean(process.env.GRIIPBUDDY_CATALOG_API);
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const string = (value: unknown) => typeof value === 'string' ? value : '';
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const strings = (value: unknown) => rows(value).filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
const images = (values: unknown[]) => [...new Set(values.flatMap((value) => approvedCatalogImage(string(value)) ?? []))];
export const objectId = (value: string) => /^[a-f0-9]{24}$/i.test(value);
const ref = (value: unknown) => typeof value === 'string' ? value : string(record(value)._id);

export async function catalogGet(path: string, params?: URLSearchParams, { missing = false, reference = false } = {}) {
  const base = process.env.GRIIPBUDDY_CATALOG_API ?? '';
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(base)) {
    throw new CatalogError('Set the catalog API to the isolated loopback recovery service.');
  }
  const query = params?.toString();
  const response = await fetch(base + path + (query ? '?' + query : ''), {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    ...(reference && process.env.GRIIPBUDDY_CHECKOUT !== 'integrated' ? { next: { revalidate: 60 } } : { cache: 'no-store' }),
  }).catch(() => { throw new CatalogError('The isolated catalog API did not respond.'); });
  if (response.status === 404 && missing) return null;
  if (!response.ok) throw new CatalogError('The catalog API returned an error.');
  const envelope = record(await response.json().catch(() => null));
  if (envelope.success !== true || !Object.hasOwn(envelope, 'data')) throw new CatalogError('Unexpected catalog API response.');
  return envelope.data;
}

export function apiMarkets(value: unknown): Market[] {
  const entries = rows(value).flatMap((row) => {
    const { _id, code, name, currency, is_active } = record(row);
    if (is_active !== true || !objectId(string(_id)) || !/^[A-Z]{2}$/.test(string(code))
      || !/^[A-Z]{3}$/.test(string(currency)) || !string(name).trim()) return [];
    const market: Market = {
      id: string(_id), code: string(code), name: string(name), currency: string(currency),
      locale: 'en-' + string(code), region: code === 'BD' ? 'BD' : 'INTERNATIONAL', prefix: '/' + string(code).toLowerCase(),
    };
    return [market];
  });
  return [...new Map(entries.map((market) => [market.code, market])).values()];
}

const childKeys = ['subcategories', 'sub_subcategories', 'third_subcategories'];

export function apiCategory(value: unknown, ancestors: string[] = []): Category | undefined {
  const row = record(value);
  const id = string(row._id);
  const slug = string(row.slug);
  const label = string(row.name_en) || string(row.name) || string(row.name_bn);
  if (row.is_published !== true || !objectId(id) || !validSlug(slug) || !label.trim()) return undefined;
  const path = [...ancestors, slug];
  const children = rows(row[childKeys[ancestors.length]]).flatMap((child) => apiCategory(child, path) ?? []);
  return {
    id, slug, label, path, children,
    description: string(row.description_en) || string(row.description) || string(row.description_bn),
    image: images(rows(row.media).map((item) => record(item).image))[0],
  };
}

export function apiBrands(value: unknown) {
  return new Map(rows(value).flatMap((item) => {
    const row = record(item);
    const id = ref(row);
    const name = string(row.name);
    return id && name && row.is_active === true ? [[id, { id, name }] as const] : [];
  }));
}

function variantPrice(row: Record<string, unknown>, market: Market): Money | undefined {
  const source = market.region === 'BD' && market.currency === 'BDT' ? row : record(record(row.prices)[market.currency]);
  const regular = positive(source.regular_price);
  const sale = positive(source.sale_price);
  if (regular === undefined) return sale === undefined ? undefined : { regular: sale };
  return sale !== undefined && sale < regular ? { regular, sale } : { regular };
}

function apiVariant(value: unknown, productId: string, market: Market): CatalogVariant | undefined {
  const row = record(value);
  const id = ref(row);
  if (!objectId(id) || ref(row.product) !== productId) return undefined;
  return {
    id,
    sku: string(row.sku),
    attributes: Object.fromEntries(Object.entries(record(row.attribute_values)).filter(([key, value]) => key.trim() && string(value).trim())) as Record<string, string>,
    images: images([row.image, ...rows(row.images)]),
    colorCode: /^#[a-f0-9]{6}$/i.test(string(row.color_code)) ? string(row.color_code) : undefined,
    price: variantPrice(row, market),
  };
}

function eligible(row: Record<string, unknown>, market: Market) {
  if (!market.id || row.is_published !== true || record(row.sale_channels).website !== true || (row.region ?? 'BD') !== market.region) return false;
  const countries = row.available_countries;
  if (countries == null || (Array.isArray(countries) && !countries.length)) return market.region === 'BD';
  return rows(countries).some((country) => ref(country) === market.id && record(country).is_active !== false);
}

function categoryPath(row: Record<string, unknown>, taxonomy: Map<string, Category>) {
  const references = [row.category, row.subcategory ?? row.first_subcategory, row.sub_subcategory ?? row.second_subcategory, row.third_subcategory];
  let path: string[] = [];
  for (const reference of references) {
    const match = taxonomy.get(ref(reference));
    if (!match || match.path.length !== path.length + 1 || !path.every((slug, index) => match.path[index] === slug)) break;
    path = match.path;
  }
  return path;
}

function specs(row: Record<string, unknown>) {
  return [...rows(row.product_specifications), ...rows(row.dynamic_specs)].flatMap((entry) => {
    const item = record(entry);
    const title = string(item.title);
    const values = [...new Set([
      ...strings(item.description), string(item.description), ...strings(item.options), string(record(item.imported_value).current_value),
    ].filter(Boolean))];
    return title && values.length ? [{ title, values }] : [];
  });
}

export function apiProduct(
  value: unknown,
  variants: unknown,
  market: Market,
  taxonomy: Map<string, Category>,
  brands: ReturnType<typeof apiBrands>,
): CatalogProduct | undefined {
  const row = record(value);
  const id = ref(row);
  const slug = string(row.slug);
  const name = string(row.name);
  if (!objectId(id) || !validSlug(slug) || !name.trim() || !eligible(row, market)) return undefined;
  return {
    id, slug, name, sku: string(row.sku),
    category: categoryPath(row, taxonomy),
    brand: brands.get(ref(row.brand)),
    description: string(row.description),
    images: images([row.thumbnail, ...rows(row.slider_images)]),
    variants: rows(variants).flatMap((variant) => apiVariant(variant, id, market) ?? []),
    specifications: specs(row),
    tags: [...strings(row.search_tags), ...strings(row.offer_tags)],
    labels: strings(row.highlight_labels),
    createdAt: string(row.createdAt),
    sold: typeof row.total_sold === 'number' && row.total_sold >= 0 ? row.total_sold : undefined,
  };
}
