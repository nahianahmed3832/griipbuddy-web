import type { CatalogProduct, Category, Market, Money } from './catalog';

export const fixtureMarkets: Market[] = [
  { id: 'fixture-us', code: 'US', name: 'United States', currency: 'USD', locale: 'en-US', region: 'INTERNATIONAL', prefix: '/us' },
  { id: 'fixture-gb', code: 'GB', name: 'United Kingdom', currency: 'GBP', locale: 'en-GB', region: 'INTERNATIONAL', prefix: '/gb' },
  { id: 'fixture-bd', code: 'BD', name: 'Bangladesh', currency: 'BDT', locale: 'en-BD', region: 'BD', prefix: '/bd' },
];

function category(slug: string, label: string, description: string, child: [string, string], image = '/editorial/' + slug + '.webp'): Category {
  const path = [slug];
  return {
    id: slug, slug, label, description, image, path,
    children: [{ id: child[0], slug: child[0], label: child[1], path: [...path, child[0]], children: [] }],
  };
}

export const fixtureCategories = [
  category('technology', 'Technology', 'Cases and accessories for the devices you use every day.', ['phone-cases', 'Phone cases']),
  category('fashion', 'Fashion', 'Finishing touches with a point of view.', ['sunglasses', 'Sunglasses']),
  category('clothing', 'Clothing', 'Easy pieces for the way you actually get dressed.', ['tees', 'Tees']),
  category('bags', 'Bags', 'Handy shapes for whatever the day holds.', ['everyday-bags', 'Everyday bags']),
  category('home', 'Home', 'Lighting and small accents for the spaces you live in.', ['lighting', 'Lighting'], '/catalog/dune-lamp.webp'),
  category('beauty', 'Beauty', 'Useful accessories for your daily routine.', ['vanity', 'Vanity accessories'], '/catalog/vanity-pouch.webp'),
  category('lifestyle', 'Lifestyle', 'Good company for your everyday routines.', ['drinkware', 'Drinkware']),
];

type FixtureVariant = {
  suffix: string;
  attributes: Record<string, string>;
  prices: Record<string, Money>;
  stock: number;
  images?: string[];
};

function price(USD: number, GBP: number | null, BDT: number, saleUSD?: number): Record<string, Money> {
  return {
    USD: { regular: USD, sale: saleUSD },
    ...(GBP === null ? {} : { GBP: { regular: GBP } }),
    BDT: { regular: BDT },
  };
}

const fixtures: {
  slug: string;
  name: string;
  category: string[];
  description: string;
  brand: string;
  createdAt: string;
  labels: string[];
  sold: number;
  variants: FixtureVariant[];
  specifications?: CatalogProduct['specifications'];
}[] = [
  {
    slug: 'form-case', name: 'The Form Case', category: ['technology', 'phone-cases'], description: 'A clean profile with a bold hit of blue.',
    brand: 'Studio Sample', createdAt: '2026-11-01', labels: ['New'], sold: 38,
    variants: [
      { suffix: 'STD', attributes: { Size: 'Standard', Color: 'Cobalt', Material: 'Polycarbonate' }, prices: price(34, 28, 1850), stock: 8, images: ['/catalog/form-case.webp', '/editorial/technology.webp'] },
      { suffix: 'PLUS', attributes: { Size: 'Plus', Color: 'Cobalt', Material: 'TPU' }, prices: price(39, 33, 2150), stock: 0, images: ['/editorial/technology.webp', '/catalog/form-case.webp'] },
    ],
    specifications: [{ title: 'Finish', values: ['Matte'] }],
  },
  {
    slug: 'studio-frames', name: 'Studio Frames', category: ['fashion', 'sunglasses'], description: 'Slim oval sunglasses with a quietly distinctive silhouette.',
    brand: 'Studio Sample', createdAt: '2026-10-30', labels: ['New', 'Trending'], sold: 22,
    variants: [{ suffix: 'ONYX', attributes: { Color: 'Onyx' }, prices: price(48, 39, 2450), stock: 11 }],
  },
  {
    slug: 'arc-bag', name: 'The Arc Shoulder Bag', category: ['bags', 'everyday-bags'], description: 'A curved shoulder bag for days that turn into evenings.',
    brand: 'Studio Sample', createdAt: '2026-10-27', labels: ['Best Seller'], sold: 92,
    variants: [{ suffix: 'ESPRESSO', attributes: { Color: 'Espresso' }, prices: price(104, 72, 4700, 86), stock: 10 }],
  },
  {
    slug: 'weekday-tee', name: 'Weekday Tee', category: ['clothing', 'tees'], description: 'An easy crew neck in a warm, understated neutral.',
    brand: 'Field Sample', createdAt: '2026-10-25', labels: ['New', 'Trending'], sold: 24,
    variants: [
      { suffix: 'S', attributes: { Size: 'S', Color: 'Bone', Material: 'Cotton' }, prices: price(38, 32, 1950), stock: 6 },
      { suffix: 'M', attributes: { Size: 'M', Color: 'Bone', Material: 'Cotton' }, prices: price(38, null, 1950), stock: 3 },
    ],
  },
  {
    slug: 'dune-lamp', name: 'Dune Table Lamp', category: ['home', 'lighting'], description: 'A compact dome lamp with an ivory ribbed base.',
    brand: 'Field Sample', createdAt: '2026-10-22', labels: ['New'], sold: 0,
    variants: [{ suffix: 'IVORY', attributes: { Color: 'Ivory', Material: 'Ceramic' }, prices: price(62, 49, 3250), stock: 7 }],
  },
  {
    slug: 'vanity-pouch', name: 'Soft Zip Vanity Pouch', category: ['beauty', 'vanity'], description: 'A padded zip pouch with room for everyday essentials.',
    brand: 'Studio Sample', createdAt: '2026-10-20', labels: ['New'], sold: 0,
    variants: [{ suffix: 'ROSE', attributes: { Color: 'Rose', Material: 'Nylon' }, prices: price(22, 18, 1150), stock: 7 }],
  },
  {
    slug: 'day-bottle', name: 'Day Bottle', category: ['lifestyle', 'drinkware'], description: 'An everyday bottle in a soft terracotta finish.',
    brand: 'Field Sample', createdAt: '2026-09-10', labels: ['Trending'], sold: 30,
    variants: [{ suffix: 'TERRACOTTA', attributes: { Color: 'Terracotta' }, prices: price(32, null, 1650), stock: 0 }],
  },
  {
    slug: 'market-tote', name: 'The Market Tote', category: ['bags', 'everyday-bags'], description: 'A roomy canvas tote with contrast handles.',
    brand: 'Field Sample', createdAt: '2026-09-02', labels: ['Trending'], sold: 62,
    variants: [{ suffix: 'NATURAL', attributes: { Color: 'Natural / Black', Material: 'Canvas' }, prices: price(45, 36, 2150), stock: 9 }],
  },
];

function sku(slug: string) {
  return 'DEMO-' + slug.toUpperCase();
}

export function fixtureProducts(market: Market): CatalogProduct[] {
  return fixtures.map((fixture) => ({
    id: 'fixture-' + fixture.slug,
    slug: fixture.slug,
    name: fixture.name,
    sku: sku(fixture.slug),
    category: fixture.category,
    brand: { id: fixture.brand, name: fixture.brand },
    description: fixture.description,
    images: ['/catalog/' + fixture.slug + '.webp'],
    variants: fixture.variants.map((variant) => ({
      id: fixture.slug + '-' + variant.suffix.toLowerCase(),
      sku: sku(fixture.slug) + '-' + variant.suffix,
      attributes: variant.attributes,
      images: variant.images ?? [],
      price: variant.prices[market.currency],
    })),
    specifications: fixture.specifications ?? [],
    tags: [],
    labels: fixture.labels,
    createdAt: fixture.createdAt,
    sold: fixture.sold,
  }));
}

export function fixtureStock(product: CatalogProduct, variantId: string) {
  const fixture = fixtures.find((entry) => entry.slug === product.slug);
  return fixture?.variants.find((variant) => product.slug + '-' + variant.suffix.toLowerCase() === variantId)?.stock ?? null;
}
