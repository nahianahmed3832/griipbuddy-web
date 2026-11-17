import { storefrontPath } from "../../config/storefront-path.ts";
import { merchantDimension, merchantVariantDetails } from "./merchant-fields.ts";
import type { CatalogProduct } from "./types.ts";

const schema = "https://schema.org/";

export function productMetadata(product: CatalogProduct, page: string) {
  const url = (path: string) => new URL(storefrontPath(path), page).href;
  const description = product.shortDescription || product.description;
  const images = product.images.map(({ src }) => url(src));
  const brand = product.brand?.trim();
  const brandMarkup = brand ? { brand: { "@type": "Brand", name: brand } } : undefined;
  const variants = product.variants.flatMap((variant) => {
    if (!variant.offer) return [];
    const { amountMinor, currency, stock } = variant.offer;
    const destination = new URL(page);
    destination.searchParams.set("variant", variant.id);
    const options = Object.entries(variant.options);
    const { color, size, material, pattern, gtin, mpn } = merchantVariantDetails(product, variant);
    const photo = variant.image && url(variant.image.src);
    return [{
      "@type": "Product", name: [product.name, ...options.map(([, value]) => value)].join(" · "), description,
      image: photo ? [photo, ...images.filter((src) => src !== photo)] : images,
      url: destination.href, sku: variant.id, color, size, material, pattern, gtin, mpn, ...brandMarkup,
      additionalProperty: options.filter(([key]) => !merchantDimension(key)).map(([name, value]) => ({ "@type": "PropertyValue", name, value })),
      offers: { "@type": "Offer", url: destination.href, price: (amountMinor / 100).toFixed(2), priceCurrency: currency,
        availability: schema + (stock > 0 ? "InStock" : "OutOfStock") },
    }];
  });
  if (!variants.length) return { title: product.name, description, images, markup: null };
  if (variants.length === 1) {
    return { title: product.name, description, images, markup: { "@context": schema, ...variants[0], name: product.name } };
  }
  const variesBy = [...new Set(product.variants.flatMap(({ options }) =>
    Object.keys(options).flatMap((key) => merchantDimension(key) ?? [])))].map((value) => schema + value);
  return { title: product.name, description, images, markup: {
    "@context": schema, "@type": "ProductGroup", name: product.name, description, image: images, url: page,
    productGroupID: product.id, ...brandMarkup, ...(variesBy.length && { variesBy }), hasVariant: variants,
  } };
}
