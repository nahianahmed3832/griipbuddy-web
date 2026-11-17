import type { CatalogImage, CatalogProduct, Department, ListedVariant, MarketOffer } from "./types.ts";
import { catalogDeviceById, deviceModelsByVariant, fitsSearchDevice, type PhoneModel } from "./devices.ts";
import { departmentFamily, stockedDepartments } from "./departments.ts";

export const sortOptions = [
  ["recommended", "Recommended"],
  ["newest", "Newest"],
  ["price-low", "Price: low to high"],
  ["price-high", "Price: high to low"],
  ["name", "Name: A to Z"],
] as const;

type Sort = typeof sortOptions[number][0];
export type SearchParams = Record<string, string | string[] | undefined>;

function first(value: SearchParams[string]): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function readQuery(params: SearchParams): string {
  return first(params.q).trim().replace(/\s+/g, " ").slice(0, 120);
}

type OfferedVariant = ListedVariant & { offer: MarketOffer };

export function variantChoices({ variants }: Pick<CatalogProduct, "variants">, color = ""): readonly OfferedVariant[] {
  return variants.filter((variant): variant is OfferedVariant => variant.offer !== null && (!color || variant.options.Color === color));
}

export function selectDeviceVariants(product: CatalogProduct, deviceId: string): readonly ListedVariant[] {
  return deviceModelsByVariant(product).filter(fit => fit.models.some(model => model.id === deviceId)).map(fit => fit.variant);
}

function fitSelection(fits: ReturnType<typeof deviceModelsByVariant>, exact?: PhoneModel, inferred?: PhoneModel) {
  const matches = fits.filter(({ models }) => (!exact || models.some(model => model.id === exact.id)) &&
    (!inferred || models.some(model => fitsSearchDevice(model, inferred))));
  return {
    variants: matches.map(({ variant }) => variant),
    preferred: new Set(inferred ? matches.filter(({ models }) => models.some(model => model.id === inferred.id))
      .map(({ variant }) => variant.id) : []),
  };
}

function preferExact(variants: readonly OfferedVariant[], preferred: ReadonlySet<string>) {
  if (!preferred.size) return variants;
  const exact = variants.filter(variant => preferred.has(variant.id));
  if (exact.length && (exact.some(variant => variant.offer.stock > 0) || variants.every(variant => variant.offer.stock === 0))) return exact;
  return variants;
}

export type ProductCardData = {
  id: string;
  name: string;
  slug: string;
  variantId: string;
  image: CatalogImage;
  priceMinor: number;
  regularMinor?: number;
  promotion?: MarketOffer["promotion"];
  stock: number;
  shop?: CatalogProduct["shop"];
  multiplePrices: boolean;
  inStock: boolean;
};

export function discountPercentage({ priceMinor, regularMinor }: Pick<ProductCardData, "priceMinor" | "regularMinor">): number {
  return regularMinor && regularMinor > priceMinor ? Math.floor((regularMinor - priceMinor) * 100 / regularMinor) : 0;
}

function cardForVariants(product: CatalogProduct, variants: readonly OfferedVariant[]): ProductCardData | null {
  if (!variants.length) return null;
  const buyable = variants.filter(({ offer }) => offer.stock > 0);
  const priced = buyable.length ? buyable : variants;
  const primary = priced.reduce((cheapest, variant) => variant.offer.amountMinor < cheapest.offer.amountMinor ? variant : cheapest);
  const priceMinor = primary.offer.amountMinor;
  if (!product.images.length && !primary.image) return null;
  const stock = variants.reduce((quantity, { offer }) => quantity + offer.stock, 0);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    variantId: primary.id,
    image: primary.image ?? product.images[0],
    priceMinor,
    regularMinor: primary.offer.regularMinor,
    promotion: primary.offer.promotion,
    stock,
    shop: product.shop,
    multiplePrices: priced.some(({ offer }) => offer.amountMinor !== priceMinor),
    inStock: stock > 0,
  };
}

export function toCard(product: CatalogProduct, color = "", deviceId?: string): ProductCardData | null {
  const variants = deviceId ? selectDeviceVariants(product, deviceId) : product.variants;
  return cardForVariants(product, variantChoices({ variants }, color));
}

export function toSearchCard(product: CatalogProduct, inferred: PhoneModel): ProductCardData | null {
  const { variants, preferred } = fitSelection(deviceModelsByVariant(product), undefined, inferred);
  return cardForVariants(product, preferExact(variantChoices({ variants }), preferred));
}

export function newestFirst(a: CatalogProduct, b: CatalogProduct): number {
  return b.addedOn.localeCompare(a.addedOn);
}

export function listingView(
  products: readonly CatalogProduct[],
  departments: readonly Department[],
  params: SearchParams,
  departmentPage = false,
  defaultSort: Sort = "recommended",
  priceDigits?: number,
  deviceFilters = false,
  inferredDeviceId?: string,
) {
  const departmentChoices = departmentPage ? [] : stockedDepartments(departments, products.map(product => product.departmentId));
  const department = departmentChoices.find(({ slug }) => slug === first(params.department));
  const departmentIdsInFilter = department && departmentFamily(departments, department.id);
  const inStock = first(params.availability) === "in-stock";
  const sort = sortOptions.find(([id]) => id === first(params.sort))?.[0] ?? defaultSort;
  const bound = (value: SearchParams[string]) => {
    const text = first(value);
    return priceDigits === undefined || !/^\d{1,7}(?:\.\d{1,2})?$/.test(text) ? null : Math.round(Number(text) * 10 ** priceDigits);
  };
  const min = bound(params.min);
  const max = bound(params.max);
  const sale = priceDigits !== undefined && first(params.offer) === "sale";
  const shops = [...new Map(products.flatMap(product => product.shop ? [[product.shop.id, product.shop] as const] : [])).values()];
  const shop = shops.find(shop => shop.slug === first(params.shop));
  const device = deviceFilters ? catalogDeviceById(first(params.device)) : undefined;
  const inferred = deviceFilters && inferredDeviceId ? catalogDeviceById(inferredDeviceId) : undefined;
  const devicesById = new Map<string, NonNullable<typeof device>>();
  if (device) devicesById.set(device.id, device);
  const candidates = products.map(product => {
    if (!deviceFilters) return { product, variants: variantChoices(product), preferred: new Set<string>() };
    const fits = deviceModelsByVariant(product);
    for (const { variant, models } of fits) {
      if (variant.offer) for (const model of models) {
        if (!inferred || fitsSearchDevice(model, inferred)) devicesById.set(model.id, model);
      }
    }
    const { variants, preferred } = fitSelection(fits, device, inferred);
    return { product, variants: variantChoices({ variants }), preferred };
  });
  const devices = [...devicesById.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const requestedColor = first(params.color);
  const color = requestedColor && products.some(product => variantChoices(product, requestedColor).length) ? requestedColor : "";
  const colors = [...new Set(candidates.flatMap(({ variants }) => variants.map(variant => variant.options.Color)).concat(color))]
    .filter(Boolean).sort();

  const filtered = candidates.flatMap(({ product, variants, preferred }) => {
    if (departmentIdsInFilter && !departmentIdsInFilter.has(product.departmentId)) return [];
    if (shop && product.shop?.id !== shop.id) return [];
    const matching = variants.filter(({ options, offer }) =>
      (!color || options.Color === color) && (!inStock || offer.stock > 0) &&
      (min === null || offer.amountMinor >= min) && (max === null || offer.amountMinor <= max) &&
      (!sale || (offer.regularMinor ?? 0) > offer.amountMinor));
    const card = cardForVariants(product, preferExact(matching, preferred));
    return card ? [{ product, card }] : [];
  });
  filtered.sort((a, b) => {
    if (sort === "newest") return newestFirst(a.product, b.product);
    if (sort === "price-low") return a.card.priceMinor - b.card.priceMinor;
    if (sort === "price-high") return b.card.priceMinor - a.card.priceMinor;
    if (sort === "name") return a.card.name.localeCompare(b.card.name, "en");
    return 0;
  });

  return {
    cards: filtered.map(({ card }) => card),
    departmentChoices, colors, department: department?.slug ?? "", color, inStock, sort, devices, device: device?.id ?? "",
    shop: shop?.slug ?? "", shops, min: min !== null ? first(params.min) : "", max: max !== null ? first(params.max) : "", sale,
    active: Boolean(department || color || inStock || shop || device || min !== null || max !== null || sale || sort !== defaultSort),
  };
}

export function productCards(products: readonly CatalogProduct[]): ProductCardData[] {
  return products.flatMap((product) => {
    const card = toCard(product);
    return card ? [card] : [];
  });
}
