import { ArrowRight, ArrowUpRight, Grid2X2, Sparkles, Ticket, Users, Zap } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { hostedCatalogPreview } from '@/features/public-build';
import { compareProducts, inCategory, inCollection } from '@/features/catalog/browse';
import { categoryHref, collections, marketHref, productHref, type CatalogProduct, type Category, type Market } from '@/features/catalog/catalog';
import { availableMerchandise, catalogSample, withAvailability } from '@/features/catalog/data';
import { CatalogImage } from '@/features/catalog/catalog-image';
import { CatalogGrid } from '@/features/catalog/listing';
import { record, rows } from '@/features/catalog/api';
import { ShoppingHistory } from '@/features/catalog/saved-products';
import { discoveryLinks } from '@/features/discovery/contracts';
import { ShelfRail } from './shelf-rail';
import { CampaignStage } from './campaign-stage';
import { campaignSlides, contentMedia, contentPath, contentRows, managedHeroContent, siteContent, text } from './content';

function Hero({ market, content, retail = false }: { market: Market; content: unknown; retail?: boolean }) {
  const [first, ...remaining] = campaignSlides(content, market);
  return <CampaignStage slides={[first ?? {
    title: retail ? 'Protect what you carry.' : 'Good finds. Great grip.',
    image: retail ? '/editorial/device-edit-campaign.webp' : '/editorial/marketplace-edit.webp',
    imageAlt: retail ? '' : 'Cream headphones, a cobalt bag and a sculptural lamp on orange studio plinths',
    href: marketHref(market, retail ? '/products' : '/collections/new-arrivals'),
    label: retail ? 'Shop accessories' : 'Shop new arrivals',
  }, ...remaining]} />;
}

const shortcuts = [
  { icon: Sparkles, description: 'Pick up where you left off' },
  { icon: Zap, description: 'Browse current sale prices' },
  { icon: Users, description: 'Explore offers with friends' },
  { icon: Ticket, description: 'Find and save offers' },
];

function ShopShortcuts({ market }: { market: Market }) {
  return <nav className="market-shortcuts" aria-label="Ways to shop">
      {discoveryLinks.map(({ label, path }, index) => {
        const { icon: Icon, description } = shortcuts[index];
        return <Link key={path} href={marketHref(market, path)}><span className="market-shortcut-icon"><Icon size={20} aria-hidden /></span>
          <span><strong>{label}</strong><small>{description}</small></span><ArrowUpRight className="shortcut-arrow" size={17} aria-hidden /></Link>;
      })}
    </nav>;
}

function Departments({ categories, market }: { categories: Category[]; market: Market }) {
  return (
    <section className="market-category-section" aria-labelledby="shop-categories">
      <div className="market-section-heading">
        <div><p className="eyebrow">FIND YOUR AISLE</p><h2 id="shop-categories">Shop by category</h2></div>
        <Link className="text-link" href={marketHref(market, '/products')}>Shop all <ArrowRight size={15} aria-hidden /></Link>
      </div>
      {categories.length ? <nav className="market-category-tiles" aria-label="Quick browse">
        {categories.map((category) => (
          <Link key={category.id} href={categoryHref(market, category.path)}>
            <span className="market-category-image">
              {category.image ? <CatalogImage src={category.image} alt="" fill sizes="(max-width: 700px) 40vw, 25vw" />
                : <Grid2X2 size={32} aria-hidden />}
            </span>
            <span>{category.label === category.label.toUpperCase() ? category.label.toLowerCase() : category.label}<ArrowUpRight size={16} aria-hidden /></span>
          </Link>
        ))}
      </nav> : <p className="catalog-notice">Category browsing opens when the catalog is available for this storefront.</p>}
    </section>
  );
}

function ProductShelf({ collection, market, products, rail = false, compact = false, linkVariant = collection.id === 'sale' }: {
  collection: { label: string; id: string; href?: string }; market: Market; products: CatalogProduct[]; rail?: boolean; compact?: boolean; linkVariant?: boolean;
}) {
  if (!products.length) return null;
  const grid = <CatalogGrid market={market} products={products} linkVariant={linkVariant} />;
  const heading = <div className="market-section-heading">
    <div>{!compact && <p className="eyebrow">THE CATALOG EDIT</p>}<h2>{collection.label}</h2></div>
    <Link className="text-link" href={marketHref(market, collection.href ?? '/collections/' + collection.id)}
      aria-label={'View all ' + collection.label.toLowerCase()}>View all <ArrowRight size={15} aria-hidden /></Link>
  </div>;
  return (
    <section className="home-panel home-product-shelf" aria-label={collection.label}>
      {rail ? <ShelfRail label={collection.label.toLowerCase()} heading={heading}>{grid}</ShelfRail> : <>{heading}{grid}</>}
    </section>
  );
}

function distinctProducts(products: CatalogProduct[]) {
  const names = new Set<string>();
  return products.filter((product) => {
    const name = product.name.toLowerCase().replace(/\s+/g, ' ');
    if (names.has(name)) return false;
    names.add(name);
    return true;
  });
}

async function retailEdit(market: Market, popularity = false, root?: string) {
  const candidates = (await catalogSample(market, popularity, root))
    .filter((product) => (!popularity || inCollection(product, 'best-sellers')) && (!root || inCategory(product, [root])));
  return availableMerchandise(distinctProducts(candidates).slice(0, 16));
}

async function MarketplaceShelves({ market }: { market: Market }) {
  const [latest, popular] = await Promise.all([retailEdit(market).catch(() => []), retailEdit(market, true).catch(() => [])]);
  const deals = distinctProducts([...latest, ...popular]).flatMap(product => {
    const variants = product.variants.filter(({ price }) => price?.sale !== undefined && price.sale < price.regular);
    return variants.length ? [{ ...product, variants }] : [];
  });
  const best = [...popular].sort((a, b) => compareProducts(a, b, 'popular'));
  return <>
    <ProductShelf market={market} collection={{ id: 'sale', label: 'Today’s Deals' }} products={deals.slice(0, 8)} compact rail />
    <ProductShelf market={market} collection={collections[0]} products={latest.slice(0, 8)} linkVariant compact rail />
    <ProductShelf market={market} collection={collections[1]} products={best.slice(0, 8)} linkVariant compact rail />
  </>;
}

async function DepartmentShelf({ market, category }: { market: Market; category: Category }) {
  const products = await retailEdit(market, false, category.path[0]).catch(() => []);
  const label = category.label === category.label.toUpperCase()
    ? category.label.toLowerCase().replace(/(^|\s)\w/g, char => char.toUpperCase()) : category.label;
  return <ProductShelf market={market} compact rail linkVariant
    collection={{ id: category.slug, label, href: '/category/' + category.path.map(encodeURIComponent).join('/') }}
    products={products.slice(0, 8)} />;
}

async function RetailHomepage({ market, categories }: { market: Market; categories: Category[] }) {
  const content = await managedHeroContent();
  const departments = ['phone-cases', 'screen-and-camera-protectors', 'tech-accessories'].flatMap(slug =>
    categories.find(category => category.slug === slug) ?? []);
  return <div className="home container retail-home">
    <Hero market={market} content={content} retail />
    <Suspense fallback={<div className="skeleton-shelf" aria-hidden>{[1, 2, 3, 4].map(i => <span className="skeleton-tile" key={i} />)}</div>}>
      <MarketplaceShelves market={market} />
    </Suspense>
    {departments.map(category => <Suspense key={category.id} fallback={null}>
      <DepartmentShelf market={market} category={category} />
    </Suspense>)}
    <ShoppingHistory market={market} />
    <section className="retail-discovery" aria-labelledby="ways-to-shop">
      <div className="market-section-heading"><h2 id="ways-to-shop">More ways to shop</h2></div>
      <ShopShortcuts market={market} />
    </section>
  </div>;
}

export async function Homepage({ market, categories }: { market: Market; categories: Category[] }) {
  if (hostedCatalogPreview()) return <RetailHomepage market={market} categories={categories} />;
  const [products, popular, content] = await Promise.all([catalogSample(market), catalogSample(market, true), siteContent()]);
  const homepage = record(content.homepage);
  const positioned = (value: unknown) => contentRows(value).sort((a,b) => Number(a.position) - Number(b.position));
  const curatedCategories = positioned(homepage.shop_by_category).flatMap(row => {
    const category = categories.find(item => item.id === row.category_id);
    const selected = row.subcategory_id ? category?.children.find(item => item.id === row.subcategory_id) : category;
    return selected ? [{ ...selected, label: text(row.label) || selected.label, image: contentMedia(row.icon_image_url) || selected.image }] : [];
  });
  const productById = new Map([...products, ...popular].map(product => [product.id, product]));
  const curated = (ids: unknown[]) => [...new Set(ids)].flatMap(id => productById.get(text(id)) ?? []).slice(0, 5);
  const newest = curated(positioned(homepage.new_arrivals).flatMap(row => rows(row.product_ids)));
  const best = curated(positioned(homepage.best_selling).map(row => row.product_id));
  const featured = curated(contentRows(content.featured_products).flatMap(row => rows(row.products_id)));
  const feature = record(homepage.leather_section);
  const featureImage = contentMedia(feature.banner_image_url);
  const featurePath = contentPath(feature.button_link);
  const desktop = contentRows(content.banners).find(row => contentMedia(row.banner_url));
  const mobile = contentRows(content.mobile_banners).find(row => contentMedia(row.banner_url));
  const bannerProduct = curated(rows((desktop ?? mobile)?.products_id))[0];
  const brands = [...new Map(products.flatMap(({ brand }) => brand ? [[brand.id, brand] as const] : [])).values()].slice(0, 8);
  const sale = products.flatMap((product) => {
    const variants = product.variants.filter((variant) => variant.price?.sale !== undefined);
    return variants.length ? [{ ...product, variants }] : [];
  }).slice(0, 5);
  const selections = [
    newest.length ? newest : [...products].sort((a, b) => compareProducts(a, b, 'newest')).slice(0, 5),
    best.length ? best : popular.filter((product) => inCollection(product, 'best-sellers')).sort((a, b) => compareProducts(a, b, 'popular')).slice(0, 5),
    products.filter((product) => inCollection(product, 'trending')).slice(0, 5),
  ];
  const decorated = new Map((await withAvailability([...new Map(selections.flat().map((product) => [product.id, product])).values()]))
    .map((product) => [product.id, product.availability]));
  const bags = categories.find((category) => category.slug === 'bags');

  return (
    <div className="home container">
        <Hero market={market} content={content.hero_section} />
        <ShopShortcuts market={market} />
        <Departments market={market} categories={curatedCategories.length ? curatedCategories : categories} />
        {(desktop || mobile) && <section className="cms-banner" aria-label="Featured campaign">
          <picture>
            {mobile && <source media="(max-width: 760px)" srcSet={contentMedia(mobile.banner_url)}/>}
            <img src={contentMedia((desktop ?? mobile)?.banner_url)} alt="GriipBuddy campaign" loading="lazy"/>
          </picture>
          {bannerProduct && <Link className="text-link" href={productHref(market, bannerProduct.slug)}>Shop featured product <ArrowRight size={16} aria-hidden/></Link>}
        </section>}
        <ShoppingHistory market={market} />
        <ProductShelf market={market} collection={{ id: 'sale', label: 'On sale' }} products={sale} />
        <ProductShelf market={market} collection={{ id: 'featured', label: 'Featured finds', href: '/products' }} products={featured} />
        {collections.filter((collection) => collection.id !== 'sale').map((collection, index) => (
          <ProductShelf key={collection.id} market={market} collection={collection}
            products={selections[index].map((product) => ({ ...product, availability: decorated.get(product.id) }))} />
        ))}
        {brands.length > 0 && <section aria-label="Browse brands">
          <div className="market-section-heading"><div><p className="eyebrow">MEET THE MAKERS</p><h2>Browse brands</h2></div></div>
          <div className="brand-strip">{brands.map((brand) => <Link key={brand.id} className="button button-outline"
            href={marketHref(market, '/products?brand=' + encodeURIComponent(brand.id))}>{brand.name} <ArrowUpRight size={15} aria-hidden /></Link>)}</div>
        </section>}
        {(bags || feature.enabled === true) && <section className="campaign" aria-labelledby="campaign-title">
          <div className="campaign-image">
            <Image src={feature.enabled === true && featureImage ? featureImage : '/editorial/campaign.webp'} alt="" fill
              unoptimized={feature.enabled === true && Boolean(featureImage?.startsWith('https:'))}
              sizes="(max-width: 760px) 96vw, 54vw" />
          </div>
          <div className="campaign-copy">
            <p className="eyebrow">The Bag Edit</p>
            <h2 id="campaign-title">{feature.enabled === true ? text(feature.title) : 'Bags for every day.'}</h2>
            {feature.enabled === true && <p>{text(feature.subtitle)}</p>}
            <Link className="text-link" href={feature.enabled === true && featurePath ? marketHref(market, featurePath)
              : bags ? categoryHref(market, bags.path) : marketHref(market, '/products')}>
              {feature.enabled === true ? text(feature.button_text) : 'Shop bags'} <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
        </section>}
    </div>
  );
}
