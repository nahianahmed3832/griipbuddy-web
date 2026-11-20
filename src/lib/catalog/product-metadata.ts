import { storefrontPath } from "../../config/storefront-path.ts";
import { markets, type Currency, type MarketId } from "../../config/markets.ts";
import type { PublicCatalogVariant } from "./connected-public.ts";
import { validGtin } from "./identifiers.ts";
import { merchantDimension } from "./merchant-fields.ts";
import type { CatalogImage, CatalogProduct } from "./types.ts";

const schema = "https://schema.org/";

type ProductIdentity = {
  id: string;
  name: string;
  description: string;
  shortDescription?: string | null;
  brand?: string | null;
  images: readonly CatalogImage[];
};
type MarkupVariant = {
  id: string;
  sku: string;
  images: readonly CatalogImage[];
  gtin?: string | null;
  mpn?: string | null;
  options: readonly { key: string; label: string; value: string }[];
  landingPage?: string;
  offer?: {
    marketId: MarketId;
    currency: Currency;
    amountMinor: number;
    availability?: "InStock" | "OutOfStock";
  };
};

function parentPage(address: string) {
  const page = new URL(address);
  const context = new URLSearchParams();
  for (const key of ["market", "lang"]) {
    const value = page.searchParams.get(key);
    if (value) context.set(key, value);
  }
  page.search = context.toString();
  page.hash = "";
  return page;
}

function imageUrls(images: readonly CatalogImage[], page: URL) {
  return [...new Set(images.flatMap(({ src }) => {
    if (!/^\/(?![\\/])/.test(src)) return [];
    const url = new URL(storefrontPath(src), page);
    return url.origin === page.origin ? [url.href] : [];
  }))];
}

function buildProductMetadata(product: ProductIdentity, address: string, rows: readonly MarkupVariant[]) {
  const page = parentPage(address);
  const description = product.shortDescription || product.description;
  const images = imageUrls(product.images, page);
  const brand = product.brand?.trim();
  const brandMarkup = brand ? { brand: { "@type": "Brand", name: brand } } : undefined;
  const variants = rows.map(variant => {
    const url = variant.landingPage ? parentPage(variant.landingPage) : new URL(page);
    url.searchParams.set("variant", variant.id);
    const dimensions: Partial<Record<NonNullable<ReturnType<typeof merchantDimension>>, string>> = {};
    const additionalProperty = variant.options.flatMap(({ key, label, value }) => {
      const dimension = merchantDimension(key);
      if (!dimension) return [{ "@type": "PropertyValue", name: label, value }];
      dimensions[dimension] ??= value;
      return [];
    });
    const { offer } = variant;
    const digits = offer ? markets[offer.marketId].minorDigits : 0;
    const offers = offer && offer.currency === markets[offer.marketId].currency &&
      Number.isSafeInteger(offer.amountMinor) && offer.amountMinor > 0 ? {
        "@type": "Offer", url: url.href, price: (offer.amountMinor / 10 ** digits).toFixed(digits),
        priceCurrency: offer.currency, ...(offer.availability && { availability: schema + offer.availability }),
      } : undefined;
    const gtin = validGtin(variant.gtin) ? variant.gtin : undefined;
    return {
      "@type": "Product", name: [product.name, ...variant.options.map(({ value }) => value)].join(" · "), description,
      image: imageUrls([...variant.images, ...product.images], page), url: url.href, sku: variant.sku,
      ...dimensions, gtin, mpn: variant.mpn?.trim() || undefined, ...brandMarkup,
      ...(additionalProperty.length > 0 && { additionalProperty }), ...(offers && { offers }),
    };
  });
  if (!variants.length) return { title: product.name, description, images, markup: null };
  if (variants.length === 1) {
    return { title: product.name, description, images, markup: { "@context": schema, ...variants[0] } };
  }
  const variesBy = [...new Set(rows.flatMap(({ options }) => options.flatMap(({ key }) => merchantDimension(key) ?? [])))]
    .filter(dimension => new Set(variants.map(variant => variant[dimension])).size > 1)
    .map(dimension => schema + dimension);
  return { title: product.name, description, images, markup: {
    "@context": schema, "@type": "ProductGroup", name: product.name, description, image: images, url: page.href,
    productGroupID: product.id, ...brandMarkup, ...(variesBy.length > 0 && { variesBy }), hasVariant: variants,
  } };
}

export function productMetadata(product: CatalogProduct, page: string,
  connected: readonly PublicCatalogVariant[] = [], legacyLanding = page) {
  const legacy = product.variants.flatMap((variant): MarkupVariant[] => variant.offer ? [{
    id: variant.id, sku: variant.sku ?? variant.id, images: variant.image ? [variant.image] : [],
    gtin: variant.gtin, mpn: variant.mpn, landingPage: legacyLanding,
    options: Object.entries(variant.options).map(([label, value]) => ({ key: label, label, value })),
    offer: { ...variant.offer, availability: variant.offer.stock > 0 ? "InStock" : "OutOfStock" },
  }] : []);
  return buildProductMetadata(product, page, [...legacy, ...connected.filter(variant => variant.offer.id).map(connectedVariant)]);
}

function connectedVariant(variant: PublicCatalogVariant): MarkupVariant {
  const { image, gallery, id, sku, gtin, mpn, offer, availability } = variant;
  return {
    id, sku, gtin, mpn, images: image ? [image, ...gallery] : gallery,
    options: variant.options.map(({ key, label, valueLabel }) => ({ key, label, value: valueLabel })),
    ...(offer.eligible && { offer: {
      ...offer, availability: availability === "available" ? "InStock"
        : availability === "out_of_stock" ? "OutOfStock" : undefined,
    } }),
  };
}

export function connectedProductMetadata(product: ProductIdentity, variants: readonly PublicCatalogVariant[], page: string) {
  return buildProductMetadata(product, page, variants.map(connectedVariant));
}

export function breadcrumbMetadata(crumbs: readonly { label: string; href: string }[], current: { label: string; href: string }) {
  if (!crumbs.length) return null;
  const parent = new URL(current.href);
  return {
    "@context": schema, "@type": "BreadcrumbList",
    itemListElement: [...crumbs, current].map(({ label, href }, index) => ({
      "@type": "ListItem", position: index + 1, name: label,
      item: new URL(href.startsWith("/") ? storefrontPath(href) : href, parent).href,
    })),
  };
}
