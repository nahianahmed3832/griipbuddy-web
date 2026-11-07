import { ArrowRight, ArrowUpRight, Grid2X2, Sparkles, Ticket, Users, Zap } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { hostedCatalogPreview } from '@/features/public-build';
import { compareProducts, inCollection } from '@/features/catalog/browse';
import { categoryHref, collections, marketHref, productHref, type CatalogProduct, type Category, type Market } from '@/features/catalog/catalog';
import { availableMerchandise, catalogSample, withAvailability } from '@/features/catalog/data';
import { CatalogImage } from '@/features/catalog/catalog-image';
import { CatalogGrid } from '@/features/catalog/listing';
import { record, rows } from '@/features/catalog/api';
import { ShoppingHistory } from '@/features/catalog/saved-products';
import { discoveryLinks } from '@/features/discovery/contracts';
import { ShelfRail } from './shelf-rail';
import { contentMedia, contentPath, contentRows, siteContent, text } from './content';

function Hero({ market, content }: { market: Market; content: Record<string, unknown> }) {
  const button = record(content.button);
  const video = contentMedia(content.video_url);
  const cover = contentMedia(content.thumbnail_url);
  const destination = contentPath(button.redirect_route);
  return (
    <section className="market-hero" aria-labelledby="hero-title">
      <div className="market-hero-copy">
        <p className="eyebrow"><Sparkles size={15} aria-hidden /> THE GRIIPBUDDY EDIT</p>
        <h1 id="hero-title">{text(content.title) || <>Good finds.<br /><span>Great grip.</span></>}</h1>
        <p>Smart tech, everyday style and little upgrades for wherever life takes you.</p>
        <div className="market-hero-actions">
          <Link className="button button-primary" href={marketHref(market, button.enabled === true && destination ? destination : '/collections/new-arrivals')}>
            {(button.enabled === true && destination ? text(button.text) : '') || 'Shop new arrivals'} <ArrowRight size={17} aria-hidden />
          </Link>
          <Link className="text-link" href={marketHref(market, '/products')}>Shop all</Link>
        </div>
      </div>
      <div className="market-hero-image">
        {video ? <video controls playsInline preload="none" poster={cover} src={video} className="cms-hero-video" aria-label="Campaign video"/>
          : <Image src={cover || '/editorial/marketplace-edit.webp'} alt={cover ? '' : 'Cream headphones, a cobalt bag and a sculptural lamp on orange studio plinths'}
            fill priority unoptimized={Boolean(cover?.startsWith('https:'))} sizes="(max-width: 700px) 94vw, 56vw" />}
        {!video && !cover && <span className="market-art-caption">THE EVERYDAY UPGRADE</span>}
      </div>
    </section>
  );
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

function ProductShelf({ collection, market, products, rail = false, linkVariant = collection.id === 'sale' }: {
  collection: { label: string; id: string; href?: string }; market: Market; products: CatalogProduct[]; rail?: boolean; linkVariant?: boolean;
}) {
  if (!products.length) return null;
  const grid = <CatalogGrid market={market} products={products} linkVariant={linkVariant} />;
  const heading = <div className="market-section-heading">
    <div><p className="eyebrow">THE CATALOG EDIT</p><h2>{collection.label}</h2></div>
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

async function retailEdit(market: Market, popular = false) {
  const candidates = (await catalogSample(market, popular)).filter((product) => !popular || inCollection(product, 'best-sellers'));
  return availableMerchandise(distinctProducts(candidates).slice(0, 16));
}

function RetailHeroFeature({ market, category }: { market: Market; category?: Category }) {
  const photo = <Image src="/editorial/device-edit-campaign.webp"
    alt={category ? '' : 'White, gray and charcoal phone cases with orange camera rims on terracotta'}
    fill priority sizes="(max-width: 760px) 100vw, (max-width: 960px) 62vw, (max-width: 1550px) 55vw, 795px" />;
  if (!category) return <div className="retail-hero-feature">{photo}</div>;
  return <Link className="retail-hero-feature" prefetch={false} href={categoryHref(market, category.path)}>
    {photo}<span className="retail-hero-caption">Shop phone cases <ArrowUpRight aria-hidden size={16} /></span>
  </Link>;
}

async function RetailShelf({ market, arrivals, best }: {
  market: Market; arrivals: Promise<CatalogProduct[]>; best?: Promise<CatalogProduct[]>;
}) {
  const newest = await arrivals;
  const shown = new Set(newest.map((product) => product.id));
  const products = best ? (await best).filter((product) => !shown.has(product.id)).slice(0, 8) : newest;
  return <ProductShelf market={market} collection={collections[best ? 1 : 0]} products={products} linkVariant rail />;
}

const retailStories = [
  { slug: 'phone-cases', image: '/editorial/device-edit-phone-cases.webp', title: 'A case for every day', copy: 'Find a finish and fit for the phone you reach for most.' },
  { slug: 'screen-and-camera-protectors', image: '/editorial/device-edit-camera-protection.webp', title: 'Keep the details sharp', copy: 'Explore screen and camera protection by device.' },
];

function RetailStories({ market, categories }: { market: Market; categories: Category[] }) {
  const stories = retailStories.flatMap((story) => {
    const category = categories.find((entry) => entry.slug === story.slug);
    return category ? [{ ...story, category }] : [];
  });
  if (!stories.length) return null;
  return <section className="retail-stories" aria-labelledby="retail-stories-title">
    <div className="market-section-heading">
      <div><p className="eyebrow">THE EVERYDAY EDIT</p><h2 id="retail-stories-title">Made for your device</h2></div>
    </div>
    <div className="retail-story-grid">
      {stories.map(({ category, image, title, copy }) => <article className="retail-story" key={category.id}>
        <Link className="retail-story-image" href={categoryHref(market, category.path)} tabIndex={-1} aria-hidden>
          <Image src={image} alt="" fill sizes="(max-width: 540px) 92vw, (max-width: 1550px) 46vw, 700px" />
        </Link>
        <div className="retail-story-copy">
          <p className="eyebrow">{category.label}</p><h3>{title}</h3><p>{copy}</p>
          <Link className="text-link" href={categoryHref(market, category.path)}>Explore {category.label.toLowerCase()} <ArrowUpRight size={16} aria-hidden /></Link>
        </div>
      </article>)}
    </div>
  </section>;
}

function RetailHomepage({ market, categories }: { market: Market; categories: Category[] }) {
  const best = retailEdit(market, true).catch(() => []);
  const arrivals = retailEdit(market).then(products => products.slice(0, 8)).catch(() => []);
  const phoneCases = categories.find(({ slug }) => slug === 'phone-cases');
  return <>
    <section className="container retail-hero" aria-labelledby="hero-title">
      <div className="retail-hero-copy">
        <p className="eyebrow"><span aria-hidden /> THE DEVICE EDIT</p>
        <h1 id="hero-title">Protect what<br /> you carry.</h1>
        <p>Phone cases, screen protectors and everyday tech accessories.</p>
        <div className="market-hero-actions">
          <Link className="button button-primary" href={marketHref(market, '/products')}>Shop accessories <ArrowRight size={17} aria-hidden /></Link>
          <Link className="text-link" href={marketHref(market, '/collections/new-arrivals')}>New arrivals <ArrowUpRight size={15} aria-hidden /></Link>
        </div>
      </div>
      <RetailHeroFeature market={market} category={phoneCases} />
    </section>
    <div className="home container retail-home">
      <Departments market={market} categories={categories} />
      <Suspense fallback={<div className="skeleton-shelf" aria-hidden>{[1, 2, 3, 4].map(i => <span className="skeleton-tile" key={i} />)}</div>}>
        <RetailShelf market={market} arrivals={arrivals} />
      </Suspense>
      <RetailStories market={market} categories={categories} />
      <Suspense fallback={null}><RetailShelf market={market} arrivals={arrivals} best={best} /></Suspense>
      <section className="retail-discovery" aria-labelledby="ways-to-shop">
        <div className="market-section-heading"><div><p className="eyebrow">THE MARKETPLACE</p><h2 id="ways-to-shop">More ways to shop</h2></div></div>
        <ShopShortcuts market={market} />
      </section>
      <section className="retail-membership">
        <div><p className="eyebrow">GRIIPBUDDY REWARDS</p><h2>Good finds add up.</h2><p>Explore GriipBuddy Rewards and see what’s available in your market.</p></div>
        <Link className="button button-outline" href={marketHref(market, '/rewards')}>Explore rewards <ArrowRight size={17} aria-hidden /></Link>
      </section>
      <ShoppingHistory market={market} />
    </div>
  </>;
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
        <Hero market={market} content={positioned(content.hero_section)[0] ?? {}} />
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
