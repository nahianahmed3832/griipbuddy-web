import type { CatalogImage, CatalogProduct, Department, ListedVariant, MarketOffer } from "./types.ts";
import { catalogDevices } from "./devices.ts";
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

export function variantChoices(product: CatalogProduct, color: string = ""): readonly ListedVariant[] {
  return product.variants.filter((variant) => variant.offer && (!color || variant.options.Color === color));
}

function priceRange(variants: readonly ListedVariant[]): number[] {
  const offered = variants.flatMap((variant) => variant.offer ? [variant.offer] : []);
  const buyable = offered.filter((offer) => offer.stock > 0);
  return (buyable.length ? buyable : offered).map((offer) => offer.amountMinor);
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

export function toCard(product: CatalogProduct, color = ""): ProductCardData | null {
  const variants = variantChoices(product, color);
  if (!variants.length) return null;
  const prices = priceRange(variants);
  const priceMinor = Math.min(...prices);
  const primary = variants.find(({ offer }) => offer?.amountMinor === priceMinor && offer.stock > 0)
    ?? variants.find(({ offer }) => offer?.amountMinor === priceMinor);
  if (!primary || !product.images.length && !primary.image) return null;
  const stock = variants.reduce((quantity, { offer }) => quantity + (offer?.stock ?? 0), 0);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    variantId: primary.id,
    image: primary.image ?? product.images[0],
    priceMinor,
    regularMinor: primary.offer?.regularMinor,
    promotion: primary.offer?.promotion,
    stock,
    shop: product.shop,
    multiplePrices: new Set(prices).size > 1,
    inStock: stock > 0,
  };
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
) {
  const departmentChoices = departmentPage ? [] : stockedDepartments(departments, products.map(product => product.departmentId));
  const colors = [...new Set(products.flatMap((product) => variantChoices(product).flatMap((variant) => variant.options.Color ? [variant.options.Color] : [])))].sort();
  const department = departmentChoices.find(({ slug }) => slug === first(params.department));
  const departmentIdsInFilter = department && departmentFamily(departments, department.id);
  const color = colors.find((value) => value === first(params.color)) ?? "";
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
  const devices = deviceFilters ? catalogDevices(products) : [];
  const device = devices.find(option => option.id === first(params.device));

  const filtered = products.flatMap((product) => {
    if (departmentIdsInFilter && !departmentIdsInFilter.has(product.departmentId)) return [];
    if (shop && product.shop?.id !== shop.id) return [];
    if (device && !catalogDevices([product]).some(option => option.id === device.id)) return [];
    const card = toCard(product, color);
    if (!card || inStock && !card.inStock || min !== null && card.priceMinor < min || max !== null && card.priceMinor > max ||
        sale && (card.regularMinor ?? 0) <= card.priceMinor) return [];
    return [{ product, card }];
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
