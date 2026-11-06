import 'server-only';
import { approvedCatalogImage } from './media';
import { catalogGet } from './api';
import { catalogProduct, mapLimited, variantStock } from './data';
import type { CatalogProduct, CatalogVariant, Market, SizeGuide } from './catalog';
import { lowestPricedVariant } from './browse';

export type FamilyLink = { slug: string; label: string; image?: string };
export type Addon = { product: CatalogProduct; initial: CatalogVariant; stock: number | null };
type Settings = { label?: string; family: { slug: string; label?: string }[]; stock?: Record<string, number>; addons: string[]; guide: SizeGuide | null };
const empty: Settings = { family: [], addons: [], guide: null };

export function storefrontExtrasEnabled() {
  return process.env.GRIIPBUDDY_CHECKOUT === 'integrated' && Boolean(process.env.GRIIPBUDDY_CATALOG_API);
}

export async function merchandising(product: CatalogProduct, market: Market) {
  if (!storefrontExtrasEnabled()) return { family: [] as FamilyLink[], addons: [] as Addon[], guide: null, stock: {} as Record<string, number> };
  const config = await catalogGet('/storefront/product/' + product.id).catch(() => null) as Settings | null ?? empty;
  const [family, addons] = await Promise.all([
    mapLimited(config.family, 4, async ({ slug, label }) => {
      const model = await catalogProduct(market, slug).catch(() => undefined);
      return model?.variants.some(variant => variant.price) ? {
        slug, label: label || model.name, image: model.images[0] ?? model.variants[0]?.images[0],
      } : undefined;
    }),
    mapLimited(config.addons, 4, async (slug) => {
      const accessory = await catalogProduct(market, slug).catch(() => undefined);
      if (!accessory) return undefined;
      const initial = lowestPricedVariant(accessory.variants);
      return initial ? { product: accessory, initial, stock: await variantStock(accessory, initial) } : undefined;
    }),
  ]);
  const siblings = family.flatMap(link => link ?? []);
  const guide = config.guide ? { ...config.guide, models: config.guide.models.filter(model => approvedCatalogImage(model.image)) } : null;
  return {
    family: siblings.length ? [{ slug: product.slug, label: config.label || product.name, image: product.images[0] ?? product.variants[0]?.images[0] }, ...siblings] : [],
    addons: addons.flatMap(addon => addon ?? []), guide, stock: config.stock ?? {},
  };
}
